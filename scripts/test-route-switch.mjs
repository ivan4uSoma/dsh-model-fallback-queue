/**
 * Переключение маршрута: управляющие поля и thinking-passback для резерва.
 *
 * Требование владельца: квота кончилась — работа продолжается на другой модели
 * (DeepSeek flash ⇄ GLM), включая суб-агентов, без потери качества рассуждений.
 *
 * Механика: DeepSeek в thinking-режиме требует thinking у каждого tool-call-хода, но
 * входную сигнатуру не валидирует («the input signature is not validated»,
 * api-docs.deepseek.com/api/create-message). Поэтому: своё reasoning передаём как есть,
 * а ходу с tool_use без рассуждений кладём минимальную заглушку. Thinking остаётся
 * включённым — качество не режем (прежние попытки его срезать/гасить отвергнуты).
 *
 * Функции вырезаются из index.js по балансу скобок и исполняются те же, что в бою.
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

const names = ['providerList', 'withThinkingPassback', 'routeCallOptions']
const bundle = names.map((name) => extractFunction(indexSrc, name)).join('\n')
const { withThinkingPassback, routeCallOptions } = new Function(
  `${bundle}\nreturn { providerList, withThinkingPassback, routeCallOptions }`,
)()

const CONFIG = { thinkingPassbackProviders: ['deepseek-official'] }
const text = (value) => Object.freeze({ type: 'text', text: value })
const reasoning = (value) => Object.freeze({ type: 'reasoning', text: value })
const toolCall = (id) => Object.freeze({ type: 'tool-call', id, name: 'bash', arguments: '{}' })

// ---- 1) passback: заглушка только у tool-call-ходов без рассуждений ----
const plain = Object.freeze([{ role: 'user', content: Object.freeze([text('привет')]) }])
check('нет tool-call → тот же массив', withThinkingPassback(plain) === plain)
check('undefined → undefined', withThinkingPassback(undefined) === undefined)

const toolOnly = Object.freeze({
  role: 'assistant',
  content: Object.freeze([toolCall('c1')]),
  source: Object.freeze({ kind: 'model', provider: 'zai', model: 'glm-5.3' }),
})
const withRealReasoning = Object.freeze({
  role: 'assistant',
  content: Object.freeze([reasoning('настоящее рассуждение'), text('вызываю'), toolCall('c2')]),
})
const textOnly = Object.freeze({ role: 'assistant', content: Object.freeze([text('готово')]) })
const history = Object.freeze([plain[0], toolOnly, withRealReasoning, textOnly])

const patched = withThinkingPassback(history)
check('есть что править → новый массив', patched !== history)
eq('ход без рассуждений получил thinking-заглушку',
  patched[1].content.map((b) => b.type), ['reasoning', 'tool-call'])
eq('заглушка минимальная (пробел), не выдумка',
  [patched[1].content[0].type, patched[1].content[0].text], ['reasoning', ' '])
check('настоящее reasoning не подменено',
  patched[2].content[0].text === 'настоящее рассуждение' && patched[2].content.length === 3)
check('text-only ход не тронут', patched[3] === textOnly)
check('исходная история не изменена', history[1].content.length === 1)
check('результат заморожен', Object.isFrozen(patched) && Object.isFrozen(patched[1].content))

// ---- 2) маршрут не менялся ----
const request = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  maxTokens: 256000,
  messages: history,
  sessionId: 's1',
})
const sameRoute = routeCallOptions(request, { provider: 'deepseek-official', model: 'deepseek-flash' }, CONFIG)
eq('тот же маршрут: maxTokens сохранён', sameRoute.maxTokens, 256000)
eq('тот же маршрут: reasoningEffort сохранён', sameRoute.reasoningEffort, 'max')
check('тот же маршрут: история не правится', sameRoute.messages === history)

// ---- 3) другая модель того же провайдера ----
const sameProvider = routeCallOptions(request, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, CONFIG)
check('своя модель: maxTokens снят', !('maxTokens' in sameProvider))
check('своя модель: reasoningEffort снят (резолвит цель)', !('reasoningEffort' in sameProvider))
check('своя модель: история не правится', sameProvider.messages === history)

// ---- 4) резерв на DeepSeek: thinking включён, заглушки только где нет рассуждений ----
const toDeep = routeCallOptions({ ...request, provider: 'zai', model: 'glm-5.3' }, { provider: 'deepseek-official', model: 'deepseek-flash' }, CONFIG)
eq('резерв: provider/model заменены', [toDeep.provider, toDeep.model], ['deepseek-official', 'deepseek-flash'])
check('резерв: maxTokens снят', !('maxTokens' in toDeep))
check('резерв: thinking НЕ выключен (качество сохраняем)', !('reasoningEffort' in toDeep) && toDeep.reasoningEffort !== 'off')
eq('резерв: ход без рассуждений получил thinking-блок',
  toDeep.messages[1].content.map((b) => b.type), ['reasoning', 'tool-call'])
check('резерв: настоящее reasoning сохранено',
  toDeep.messages[2].content[0].text === 'настоящее рассуждение' && toDeep.messages[2].content.length === 3)
check('резерв: исходная история не испорчена',
  history[1].content.length === 1 && history[2].content.length === 3)

// ---- 5) резерв на провайдера не из списка: историю не трогаем ----
const toZai = routeCallOptions(request, { provider: 'zai', model: 'glm-5.3' }, CONFIG)
check('резерв на z.ai: историю не правим (там reasoning_content терпим)', toZai.messages === history)
check('резерв на z.ai: thinking тоже не выключаем', !('reasoningEffort' in toZai))

if (failures.length > 0) {
  console.error(`✗ route switch: ${failures.length} failure(s), ${pass} passed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ route switch: ${pass} checks passed`)
