/**
 * Переключательная политика плагина: управляющие поля при смене маршрута и запрет
 * кросс-провайдерного перехода при истории инструментов.
 *
 * Контекст (реальный инцидент 2026-11-12 01:37, b2b):
 *  GLM-сессия, шаг 111, DeepSeek вернул 400
 *  «The `content[].thinking` in the thinking mode must be passed back to the API».
 *  Причина: очередь на любом мягком сбое шага уводила запрос в другого провайдера,
 *  а DeepSeek требует возвращать thinking у tool-call-ходов; чужая (GLM) история
 *  его не имеет, восстановление по tool-call id у чужих id не удаётся.
 *  Прежняя «адаптация» (срезать text, затем и reasoning) делала только хуже:
 *  срезала именно то, что DeepSeek требует передать.
 *
 * Как и раньше: функции вырезаются из index.js по балансу скобок и исполняются
 * ровно те же, что в бою (не копия и не регулярка по исходнику).
 *
 * Запуск: node scripts/test-route-switch.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const indexSrc = readFileSync(join(here, '..', 'index.js'), 'utf8')

let pass = 0
const failures = []
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    return
  }
  failures.push(`${name}${extra ? ` — ${extra}` : ''}`)
}
function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  check(name, g === w, `got ${g} want ${w}`)
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  let i = src.indexOf('(', start)
  let depth = 0
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1
    else if (src[i] === ')') {
      depth -= 1
      if (depth === 0) break
    }
  }
  let j = src.indexOf('{', i)
  depth = 0
  for (; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, j + 1)
    }
  }
  throw new Error(`unbalanced braces for ${name}`)
}

const names = ['historyHasToolExchange', 'crossProviderSwitchAllowed', 'routeCallOptions']
const bundle = names.map((name) => extractFunction(indexSrc, name)).join('\n')
const { historyHasToolExchange, crossProviderSwitchAllowed, routeCallOptions } = new Function(
  `${bundle}\nreturn { historyHasToolExchange, crossProviderSwitchAllowed, routeCallOptions }`,
)()

const text = (value) => Object.freeze({ type: 'text', text: value })
const reasoning = (value) => Object.freeze({ type: 'reasoning', text: value })
const toolCall = (id) => Object.freeze({ type: 'tool-call', id, name: 'bash', arguments: '{}' })
const toolResult = (id) => Object.freeze({ type: 'tool-result', id, content: 'ok' })

// ---- 1) признак истории инструментов ----
check('пустая история → false', historyHasToolExchange([]) === false)
check('undefined → false', historyHasToolExchange(undefined) === false)
check('только текст → false', historyHasToolExchange([{ role: 'user', content: [text('привет')] },
  { role: 'assistant', content: [reasoning('думаю'), text('ок')] }]) === false)
check('assistant с tool-call → true', historyHasToolExchange([{ role: 'assistant', content: [toolCall('c1')] }]) === true)
check('assistant с reasoning + tool-call → true',
  historyHasToolExchange([{ role: 'assistant', content: [reasoning('думаю'), toolCall('c1')] }]) === true)
check('роль tool → true', historyHasToolExchange([{ role: 'tool', content: [text('вывод')], toolCallId: 'c1' }]) === true)
check('блок tool-result в user → true', historyHasToolExchange([{ role: 'user', content: [toolResult('c1')] }]) === true)
check('мусор в массиве не ломает', historyHasToolExchange([null, undefined, 'x', { role: 'user' }]) === false)

// ---- 2) политика перехода между провайдерами ----
const routeZai = { provider: 'zai', model: 'glm-5.3' }
const routeDeep = { provider: 'deepseek-official', model: 'deepseek-flash' }
check('без истории инструментов: переход на другого провайдера разрешён',
  crossProviderSwitchAllowed(false, 'zai', routeDeep) === true)
check('без истории: своя строка разрешена', crossProviderSwitchAllowed(false, 'zai', routeZai) === true)
check('с историей инструментов: свой провайдер разрешён',
  crossProviderSwitchAllowed(true, 'zai', routeZai) === true)
check('с историей инструментов: чужой провайдер запрещён (боевой случай 01:37)',
  crossProviderSwitchAllowed(true, 'zai', routeDeep) === false)
check('с историей инструментов: чужой провайдер запрещён и в обратную сторону',
  crossProviderSwitchAllowed(true, 'deepseek-official', routeZai) === false)
check('с историей: невалидная строка очереди запрещена', crossProviderSwitchAllowed(true, 'zai', {}) === false)
check('без истории: невалидная строка не падает', crossProviderSwitchAllowed(false, 'zai', {}) === true)

// ---- 3) смена маршрута: управляющие поля не переносятся ----
const request = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  maxTokens: 256000,
  messages: Object.freeze([{ role: 'user', content: [text('привет')] }]),
  sessionId: 's1',
})
const toZai = routeCallOptions(request, routeZai)
eq('смена маршрута: provider/model заменены', [toZai.provider, toZai.model], ['zai', 'glm-5.3'])
check('смена маршрута: maxTokens снят (иначе z.ai 400 code 1210)', !('maxTokens' in toZai))
check('смена маршрута: reasoningEffort снят', !('reasoningEffort' in toZai))
eq('смена маршрута: sessionId сохранён', toZai.sessionId, 's1')
check('смена маршрута: исходный объект не изменён', request.maxTokens === 256000 && request.reasoningEffort === 'max')
eq('история не переписывается (никакой «адаптации» блоков)', toZai.messages, request.messages)

// ---- 4) маршрут не менялся → поля остаются, объект новый ----
const sameRoute = routeCallOptions(request, { provider: 'deepseek-official', model: 'deepseek-flash' })
eq('тот же маршрут: maxTokens сохранён', sameRoute.maxTokens, 256000)
eq('тот же маршрут: reasoningEffort сохранён', sameRoute.reasoningEffort, 'max')
check('тот же маршрут: это копия, а не исходник', sameRoute !== request)

if (failures.length > 0) {
  console.error(`✗ route switch: ${failures.length} failure(s), ${pass} passed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ route switch: ${pass} checks passed`)
