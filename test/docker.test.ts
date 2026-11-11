import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstSurvivingContainer } from '../src/lib/docker.js'

test('a container being removed is not one to reopen', () => {
	assert.equal(firstSurvivingContainer('d98f64ae791a removing\n'), '')
	assert.equal(firstSurvivingContainer('d98f64ae791a removing\n4b87166c2d57 exited\n'), '4b87166c2d57')
	assert.equal(firstSurvivingContainer('4b87166c2d57 running\n'), '4b87166c2d57')
	assert.equal(firstSurvivingContainer(''), '')
})
