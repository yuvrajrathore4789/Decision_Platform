'use strict';
const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

async function connectDb(uri = env.MONGO_URI) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  logger.info(`MongoDB connected: ${mongoose.connection.name}`);
}
const disconnectDb = () => mongoose.disconnect();

module.exports = { connectDb, disconnectDb };
