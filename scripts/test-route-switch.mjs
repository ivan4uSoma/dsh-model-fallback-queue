/**
 * Переключение маршрута: управляющие поля и форма резервного запроса.
 *
 * Требование владельца: когда у модели кончилась квота — продолжить на другой модели
 * (DeepSeek flash ⇄ GLM), включая суб-агентов, без подмены истории.
 *
 * Почему резерв идёт без thinking: DeepSeek в thinking-режиме требует вернуть thinking
 * у каждого tool-call-хода («If thinking content is omitted, the service may recover it
 * using the tool-call IDs; if recovery is required but fails, the request returns a 400
 * error», api-docs.deepseek.com/guides/anthropic_api). У GLM-истории своего thinking для
 * DeepSeek нет. Поэтому резервный запрос: reasoningEffort 'off' + reasoning-блоки не
 * передаются; это обычный tool-loop, который принимают оба провайдера.
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

const names = ['withoutReasoning', 'routeCallOptions']
const bundle = names.map((name) => extractFunction(indexSrc, name)).join('\n')
const { withoutReasoning, routeCallOptions } = new Function(
  `${bundle}\nreturn { withoutReasoning, routeCallOptions }`,
)()

const text = (value) => Object.freeze({ type: 'text', text: value })
const reasoning = (value) => Object.freeze({ type: 'reasoning', text: value })
const toolCall = (id) => Object.freeze({ type: 'tool-call', id, name: 'bash', arguments: '{}' })

// ---- 1) без reasoning: массив без блоков возвращается как есть ----
const plain = Object.freeze([{ role: 'user', content: Object.freeze([text('привет')]) }])
check('нет reasoning → тот же массив', withoutReasoning(plain) === plain)
check('undefined → undefined', withoutReasoning(undefined) === undefined)

const withReasoning = Object.freeze([
  Object.freeze({ role: 'user', content: Object.freeze([text('привет')]) }),
  Object.freeze({
    role: 'assistant',
    content: Object.freeze([reasoning('думаю'), text('вызываю'), toolCall('c1')]),
    source: Object.freeze({ kind: 'model', provider: 'zai', model: 'glm-5.3' }),
  }),
  Object.freeze({ role: 'tool', content: Object.freeze([text('ok')]), toolCallId: 'c1' }),
])
const stripped = withoutReasoning(withReasoning)
check('reasoning есть → новый массив', stripped !== withReasoning)
eq('reasoning снят, text и tool-call остались', stripped[1].content.map((b) => b.type), ['text', 'tool-call'])
eq('user и tool не тронуты', [stripped[0], stripped[2]], [withReasoning[0], withReasoning[2]])
eq('source сохранён', [stripped[1].source.provider, stripped[1].source.model], ['zai', 'glm-5.3'])
check('исходная история не изменена', withReasoning[1].content.length === 3)
check('результат заморожен', Object.isFrozen(stripped) && Object.isFrozen(stripped[1].content))

// ---- 2) маршрут не менялся → копия с полями ----
const request = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  maxTokens: 256000,
  messages: withReasoning,
  sessionId: 's1',
})
const sameRoute = routeCallOptions(request, { provider: 'deepseek-official', model: 'deepseek-flash' })
eq('тот же маршрут: maxTokens сохранён', sameRoute.maxTokens, 256000)
eq('тот же маршрут: reasoningEffort сохранён', sameRoute.reasoningEffort, 'max')
check('тот же маршрут: сообщения не переписываются', sameRoute.messages === withReasoning)

// ---- 3) другая модель того же провайдера: снять управляющие поля ----
const sameProvider = routeCallOptions(request, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
eq('своя модель: provider/model заменены', [sameProvider.provider, sameProvider.model], ['deepseek-official', 'deepseek-v4-pro'])
check('своя модель: maxTokens снят', !('maxTokens' in sameProvider))
check('своя модель: reasoningEffort снят (резолвит целевая модель)', !('reasoningEffort' in sameProvider))
check('своя модель: история не переписывается', sameProvider.messages === withReasoning)

// ---- 4) другой провайдер: без thinking и без reasoning (сценарий владельца) ----
const toZai = routeCallOptions(request, { provider: 'zai', model: 'glm-5.3' })
eq('резерв: provider/model заменены', [toZai.provider, toZai.model], ['zai', 'glm-5.3'])
check('резерв: maxTokens снят (иначе z.ai 400 code 1210)', !('maxTokens' in toZai))
eq('резерв: thinking выключен (иначе DeepSeek 400 content[].thinking)', toZai.reasoningEffort, 'off')
eq('резерв: reasoning-блоков нет', toZai.messages[1].content.map((b) => b.type), ['text', 'tool-call'])
check('резерв: исходный запрос не изменён', request.reasoningEffort === 'max' && request.maxTokens === 256000 && withReasoning[1].content.length === 3)

const backToDeep = routeCallOptions({ ...request, provider: 'zai', model: 'glm-5.3' }, { provider: 'deepseek-official', model: 'deepseek-flash' })
eq('резерв в обратную сторону: thinking выключен', backToDeep.reasoningEffort, 'off')
eq('резерв в обратную сторону: reasoning снят', backToDeep.messages[1].content.map((b) => b.type), ['text', 'tool-call'])

if (failures.length > 0) {
  console.error(`✗ route switch: ${failures.length} failure(s), ${pass} passed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ route switch: ${pass} checks passed`)
