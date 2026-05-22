import { createOpenAI } from '@ai-sdk/openai'
import { streamText, tool, stepCountIs } from 'ai'
import { z } from 'zod'

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.error('DEEPSEEK_API_KEY is not set')
    process.exit(1)
  }

  const wrappedFetch = async (url, init) => {
    if (init && init.method === 'POST' && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        if (body.messages && Array.isArray(body.messages)) {
          let injected = false
          for (const msg of body.messages) {
            if (msg.role === 'assistant' && msg.tool_calls && msg.reasoning_content === undefined) {
              msg.reasoning_content = ''
              injected = true
            }
          }
          if (injected) {
            console.log('\n[wrappedFetch] Injected reasoning_content: "" into assistant message.')
          }
        }
        init = { ...init, body: JSON.stringify(body) }
      } catch (err) {
        console.error('Error in wrappedFetch parsing:', err)
      }
    }
    return globalThis.fetch(url, init)
  }

  const openai = createOpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey,
    fetch: wrappedFetch,
  })

  // We use deepseek-reasoner (DeepSeek-R1) which is the reasoning/thinking model
  const model = openai.chat('deepseek-reasoner')

  const testTool = tool({
    description: 'A test tool to respond to questions',
    inputSchema: z.object({
      question: z.string(),
    }),
    execute: async ({ question }) => {
      console.log('Tool executing with:', question)
      return { answer: 'The capital of France is Paris.' }
    },
  })

  console.log('Starting streamText with deepseek-reasoner...')
  try {
    const result = streamText({
      model,
      prompt: 'Call the testTool with the question "What is the capital of France?", and then tell me the answer.',
      tools: {
        testTool,
      },
      stopWhen: stepCountIs(5),
    })

    for await (const part of result.fullStream) {
      console.log('Part type:', part.type, Object.keys(part))
      if (part.type === 'text-delta') {
        process.stdout.write('  [Text Delta]: ' + part.text + '\n')
      } else if (part.type === 'tool-call') {
        console.log('  [Tool Call]', part.toolName, part.input)
      } else if (part.type === 'tool-result') {
        console.log('  [Tool Result]', part.toolName, part.output)
      }
    }
    console.log('\nSuccess!')
    const steps = await result.steps
    console.log('\n[Steps Details]:', JSON.stringify(steps, null, 2))
  } catch (err) {
    console.error('\nStream failed with error:', err)
  }
}

main()
