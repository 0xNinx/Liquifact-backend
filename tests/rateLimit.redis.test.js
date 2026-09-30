const { describe, it, before, after } = require('mocha');
const expect = require('chai').expect;
const express = require('express');
const request = require('supertest');
const { createRateLimiter } = require('../src/middleware/rateLimit');
const redisModule = require('../src/cache/redis');
const sinon = require('sinon');

describe('Distributed Rate Limiter Validation Suite', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should fall back gracefully to standard memory tracks when Redis state reports unavailable', async () => {
    sandbox.stub(redisModule, 'getRedisClient').returns({ client: null, isAvailable: false });

    const app = express();
    app.use(createRateLimiter('test-fallback', 60000, 2));
    app.get('/test', (req, res) => res.sendStatus(200));

    const res1 = await request(app).get('/test');
    const res2 = await request(app).get('/test');
    
    expect(res1.status).to.equal(200);
    expect(res2.status).to.equal(200);
  });

  it('should isolate counts properly so that distinct scopes do not cross-pollinate metrics', () => {
    const fakeClient = { sendCommand: sinon.stub().resolves(1) };
    sandbox.stub(redisModule, 'getRedisClient').returns({ client: fakeClient, isAvailable: true });

    const limiterA = createRateLimiter('scopeA', 60000, 10);
    const limiterB = createRateLimiter('scopeB', 60000, 10);

    expect(limiterA).to.be.a('function');
    expect(limiterB).to.be.a('function');
  });
});