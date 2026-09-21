import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultProjectId, isValidProjectId, titlecase } from '../src/lib/paths.js'

test('defaultProjectId lands on the wizard slug charset', () => {
	assert.equal(defaultProjectId('/home/me/My App'), 'my-app')
	assert.equal(defaultProjectId('/x/my_app.v2'), 'my-app-v2')
	assert.equal(defaultProjectId('/x/--weird--'), 'weird')
	assert.equal(defaultProjectId('/x/___'), 'devcontainer')
	for (const dir of ['/a/Foo Bar', '/a/x.y', '/a/ok-name']) {
		assert.ok(isValidProjectId(defaultProjectId(dir)), dir)
	}
})

test('isValidProjectId is install.sh\'s regex', () => {
	assert.ok(isValidProjectId('a'))
	assert.ok(isValidProjectId('my-app-2'))
	assert.ok(!isValidProjectId('-a'))
	assert.ok(!isValidProjectId('a-'))
	assert.ok(!isValidProjectId('My-App'))
	assert.ok(!isValidProjectId('my_app'))
	assert.ok(!isValidProjectId(''))
})

test('titlecase mirrors the bash helper', () => {
	assert.equal(titlecase('my-app'), 'My App')
	assert.equal(titlecase('x'), 'X')
	assert.equal(titlecase('a--b'), 'A B')
})
