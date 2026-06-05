import test from 'node:test'
import assert from 'node:assert/strict'

import { githubCloneUrl, githubTokenAuth } from '../gitless-clone.mjs'

test('githubCloneUrl builds the HTTPS GitHub URL used by pure JS clone', () => {
  assert.equal(githubCloneUrl('hotwax', 'devkit'), 'https://github.com/hotwax/devkit.git')
})

test('githubTokenAuth returns no auth callback when no token is present', () => {
  assert.equal(githubTokenAuth(''), undefined)
})

test('githubTokenAuth uses the token as the Git username for GitHub HTTPS auth', () => {
  assert.deepEqual(githubTokenAuth('ghp_example')(), {
    username: 'ghp_example',
    password: 'x-oauth-basic',
  })
})
