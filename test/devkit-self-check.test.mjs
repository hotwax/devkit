import test from 'node:test'
import assert from 'node:assert/strict'

import { devkitSelfCheckCommands } from '../devkit-self-check.mjs'

test('devkitSelfCheckCommands uses the current Node executable instead of npm', () => {
  const commands = devkitSelfCheckCommands('/workspace/devkit', '/bin/node')

  assert.equal(commands.length, 8)
  assert.deepEqual(commands[0], {
    id: 'tests',
    cwd: '/workspace/devkit',
    command: '/bin/node',
    args: ['--test'],
  })
  assert.equal(commands.some((cmd) => cmd.id === 'bundle-request-syntax'), true)
  assert.equal(commands.some((cmd) => cmd.command === 'npm'), false)
})
