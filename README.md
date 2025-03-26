# ts-loggly-bulk

[![Version npm](https://img.shields.io/npm/v/ts-loggly-bulk?logo=npm&logoColor=red)](https://www.npmjs.com/package/ts-loggly-bulk)
[![Downloads npm](https://img.shields.io/npm/dm/ts-loggly-bulk?logo=npm&logoColor=red)](https://www.npmjs.com/package/ts-loggly-bulk)


A zero-dependency TypeScript client implementation for Loggly. This is intended to be a drop-in replacement for [node-loggly-bulk](https://github.com/loggly/node-loggly-bulk).

## Features

- API-compatible with the original `node-loggly-bulk`
- Full TypeScript support with complete type definitions
- Zero dependencies

## Installation

```bash
npm install ts-loggly-bulk
```

## Usage

The `ts-loggly-bulk` library is compliant with the Loggly API and provides a type-safe way to send logs to Loggly.

### Getting Started

```ts
// Import the LogglyClient class directly
import { LogglyClient } from 'ts-loggly-bulk';

// Create a new LogglyClient instance
const client = new LogglyClient({
  // Required fields
  token: "your-really-long-input-token",
  subdomain: "your-subdomain",
  
  // Optional fields
  tags: ['global-tag'],          // Tags to include with every request
  json: false,                   // Enable JSON logging (default: false)
  host: 'logs-01.loggly.com',    // Loggly host (default: 'logs-01.loggly.com')
  api: 'apiv2',                  // API version (default: 'apiv2')
  useTagHeader: true,            // Use tag header (default: true)
  isBulk: true,                  // Use bulk endpoint (default: true)
  networkErrorsOnConsole: false, // Log network errors to console (default: false)
  
  // Buffer configuration (optional)
  bufferOptions: {
    size: 500,                   // Max number of logs to buffer (default: 500)
    retriesInMilliSeconds: 30000 // Retry interval in ms (default: 30000)
  },
  
  // Authentication (optional)
  auth: {
    username: 'username',
    password: 'password'
  },
  
  // HTTP proxy (optional)
  proxy: 'http://user:pass@proxy.example.com:8080'
});
```

### Text Logging (Default)

By default, the client sends logs as plain text:

```ts
// Simple string logging
client.log('127.0.0.1 - There\'s no place like home');

// With callback
client.log('Application started successfully', function (err, result) {
  if (err) console.error('Logging error:', err);
  else console.log('Log successfully sent:', result);
});

// Shallow objects are converted to Loggly's recommended string format: key=value,key2=value2
client.log({ server: 'web-1', status: 'healthy', memory: '512MB' });
// Logged as: server=web-1,status=healthy,memory=512MB
```

### JSON Logging

To send structured logs as JSON, enable the JSON mode in your client configuration:

```ts
const client = new LogglyClient({
  token: 'token',
  subdomain: "your-subdomain",
  json: true // Enable JSON logging
});

// Log structured data (automatically stringified)
client.log({
  level: 'info',
  message: 'User logged in',
  userId: 12345,
  timestamp: new Date().toISOString()
});

// Complex nested objects are supported
const event = {
  action: 'purchase',
  amount: 125.99,
  items: [
    { id: 'SKU123', name: 'Premium Widget', quantity: 1 }
  ],
  customer: {
    id: 'cust_987',
    type: 'returning'
  }
};

client.log(event);
```

### Logging with Tags

Tags help organize and filter your logs in the Loggly interface:

```ts
// Add tags to a specific log message (these are merged with global tags)
client.log('Payment processed', ['payment', 'success'], function (err, result) {
  // Callback is optional
});
```

### Bulk Logging

When `isBulk: true` (default), logs are automatically batched and sent on an interval or when the buffer has reached the configured size.

```ts
// In bulk mode, logs are automatically batched
client.log('Log entry 1');
client.log('Log entry 2');
client.log('Log entry 3');
// These will be sent as a single request automatically

// You can also send arrays of log entries
client.log([
  { event: 'signup', userId: 'user123' },
  { event: 'profile_update', userId: 'user123', fields: ['name', 'email'] },
  { event: 'logout', userId: 'user123' }
]);
```

### Error Handling and Events

The client extends EventEmitter and emits 'log' events when logs are successfully sent:

```ts
// Listen for successful log events
client.on('log', (response) => {
  console.log('Log successfully sent to Loggly', response);
});

// Error handling with callbacks
client.log('Critical system error', ['error', 'critical'], function (err, result) {
  if (err) {
    console.error('Failed to send log to Loggly:', err);
    // Implement your fallback logging strategy here
  }
});
```

### Buffer and Retry

The client automatically buffers failed logs and retries sending them:

```ts
// Configure buffer size and retry interval
const client = new LogglyClient({
  token: 'token',
  subdomain: 'subdomain',
  bufferOptions: {
    size: 1000,                  // Store up to 1000 failed logs
    retriesInMilliSeconds: 60000 // Retry every minute
  },
  networkErrorsOnConsole: true   // Log retry attempts to console
});
```

```
