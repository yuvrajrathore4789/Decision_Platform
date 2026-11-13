'use strict';
// Must be set BEFORE app modules load.
process.env.NODE_ENV = 'test';
process.env.RETRY_BASE_MS = '0';
process.env.ENABLE_RETRY_WORKER = 'false';
process.env.DEPENDENCY_TIMEOUT_MS = '300';

const mongoose = require('mongoose');
const workflowService = require('../src/services/workflow.service');

let mongod;

/** Uses TEST_MONGO_URI if set, otherwise an in-memory MongoDB. */
async function connect() {
  if (process.env.TEST_MONGO_URI) {
    await mongoose.connect(process.env.TEST_MONGO_URI);
  } else {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }
  await Promise.all(Object.values(mongoose.models).map((m) => m.init())); // make sure unique indexes exist
}

async function reset() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await workflowService.seedFromFiles();
}

async function disconnect() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

module.exports = { connect, reset, disconnect };
