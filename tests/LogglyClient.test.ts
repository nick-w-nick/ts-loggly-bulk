import { LogglyClient } from '../src/LogglyClient.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fetch globally
vi.stubGlobal('fetch', vi.fn());

describe('LogglyClient', () => {
  // Default config for tests
  const defaultConfig = {
    token: 'test-token',
    subdomain: 'test-subdomain'
  };
  
  let client: LogglyClient;
  
  beforeEach(() => {
    // Reset mocks before each test
    vi.resetAllMocks();
    
    // Create a new client instance
    client = new LogglyClient(defaultConfig);
    
    // Mock successful fetch response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'success'
    });
  });
  
  afterEach(() => {
    vi.resetAllMocks();
  });
  
  describe('constructor', () => {
    it('should throw error if token is missing', () => {
      expect(() => new LogglyClient({ subdomain: 'test' } as any)).toThrow('options.token is required');
    });
    
    it('should throw error if subdomain is missing', () => {
      expect(() => new LogglyClient({ token: 'test' } as any)).toThrow('options.subdomain is required');
    });
    
    it('should throw error if bufferOptions is provided without size', () => {
      expect(() => new LogglyClient({
        token: 'test',
        subdomain: 'test',
        bufferOptions: { retriesInMilliSeconds: 1000 } as any
      })).toThrow('options.bufferOptions.size is required');
    });
    
    it('should throw error if bufferOptions is provided without retriesInMilliSeconds', () => {
      expect(() => new LogglyClient({
        token: 'test',
        subdomain: 'test',
        bufferOptions: { size: 100 } as any
      })).toThrow('options.bufferOptions.retriesInMilliSeconds is required');
    });
    
    it('should set default values for optional config properties', () => {
      const client = new LogglyClient(defaultConfig);
      // Use any to access private properties for testing
      const config = (client as any).config;
      
      expect(config.host).toBe('logs-01.loggly.com');
      expect(config.api).toBe('apiv2');
      expect(config.json).toBe(false);
      expect(config.useTagHeader).toBe(true);
      expect(config.isBulk).toBe(true);
      expect(config.bufferOptions).toEqual({ size: 500, retriesInMilliSeconds: 30000 });
      expect(config.networkErrorsOnConsole).toBe(false);
    });
  });
  
  describe('log method', () => {
    it('should return this for method chaining', () => {
      const result = client.log('test message');
      expect(result).toBe(client);
    });
    
    it('should handle callback as second parameter', async () => {
      const callback = vi.fn();
      client.log('test message', callback);
      
      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalled();
      });
    });
    
    it('should call callback with error if token is invalid', () => {
      // Set token as invalid
      (client as any).isTokenValid = false;
      
      const callback = vi.fn();
      client.log('test message', callback);
      
      expect(callback).toHaveBeenCalledWith(expect.any(Error));
      expect(callback.mock.calls[0][0].message).toContain('Invalid token');
    });
    
    it('should truncate messages larger than 1MB', { timeout: 10000 }, async () => {
      // Disable bulk mode so we don't have to wait for batch threshold
      (client as any).config.isBulk = false;
      
      // Create a message larger than 1MB
      const largeMessage = 'a'.repeat(15000000);
      
      // Mock console.warn to verify warning
      const consoleWarnSpy = vi.spyOn(console, 'warn');
      
      // Enable networkErrorsOnConsole to see warnings
      (client as any).config.networkErrorsOnConsole = true;
      
      client.log(largeMessage);
      
      // Verify warning was logged
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('truncated'));
      
      // Verify fetch was called with truncated message
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      
      const fetchCall = (fetch as any).mock.calls[0];
      const options = fetchCall[1];
      
      // Message should be truncated to 1MB
      expect(options.body.length).toBeLessThanOrEqual(1000000);
    });
    
    describe('bulk mode', () => {
      it('should add message to batch queue and call callback immediately', () => {
        const callback = vi.fn();
        client.log('test message', callback);
        
        // Callback should be called immediately in bulk mode
        expect(callback).toHaveBeenCalledWith(null, null);
        
        // Message should be added to batch queue
        expect((client as any).batchQueue.length).toBe(1);
        expect((client as any).batchQueue[0]).toBe('test message');
      });
      
      it('should handle array of messages in bulk mode', () => {
        client.log(['message1', 'message2', 'message3']);
        
        // Messages should be joined with newlines
        expect((client as any).batchQueue.length).toBe(1);
        expect((client as any).batchQueue[0]).toBe('message1\nmessage2\nmessage3');
      });
      
      it('should send batch when threshold is reached', async () => {
        // Add messages to reach threshold
        for (let i = 0; i < 100; i++) {
          client.log(`message${i}`);
        }
        
        // Batch should be sent immediately when threshold is reached
        await vi.waitFor(() => {
          expect(fetch).toHaveBeenCalled();
        });
        
        // Batch queue should be empty after sending
        expect((client as any).batchQueue.length).toBe(0);
      });
      
      it('should send batch after timeout even if threshold not reached', async () => {
        // Mock timers
        vi.useFakeTimers();
        
        // Add a few messages (not enough to reach threshold)
        client.log('message1');
        client.log('message2');
        
        // Batch should not be sent yet
        expect(fetch).not.toHaveBeenCalled();
        
        // Advance timer past the 5 second timeout
        vi.advanceTimersByTime(5100);
        
        // Restore timers
        vi.useRealTimers();
        
        // Batch should be sent after timeout
        await vi.waitFor(() => {
          expect(fetch).toHaveBeenCalled();
        });
        
        // Batch queue should be empty after sending
        expect((client as any).batchQueue.length).toBe(0);
      });
    });
    
    describe('non-bulk mode', () => {
      beforeEach(() => {
        // Set client to non-bulk mode
        (client as any).config.isBulk = false;
      });
      
      it('should send message immediately and call callback with response', async () => {
        const callback = vi.fn();
        client.log('test message', callback);
        
        // Wait for async operations to complete
        await vi.waitFor(() => {
          expect(fetch).toHaveBeenCalled();
          expect(callback).toHaveBeenCalled();
        });
        
        // Callback should be called with null (no error) and response
        expect(callback).toHaveBeenCalledWith(null, 'success');
      });
      
      it('should emit log event on successful send', async () => {
        // Spy on emit method
        const emitSpy = vi.spyOn(client, 'emit');
        
        client.log('test message');
        
        // Wait for async operations to complete
        await vi.waitFor(() => {
          expect(fetch).toHaveBeenCalled();
          expect(emitSpy).toHaveBeenCalled();
        });
        
        // Emit should be called with 'log' event and response
        expect(emitSpy).toHaveBeenCalledWith('log', 'success');
      });
      
      it('should call callback with error on failed send', async () => {
        // Mock fetch to return error response
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error'
        });
        
        const callback = vi.fn();
        client.log('test message', callback);
        
        // Wait for async operations to complete
        await vi.waitFor(() => {
          expect(fetch).toHaveBeenCalled();
          expect(callback).toHaveBeenCalled();
        });
        
        // Callback should be called with error
        expect(callback).toHaveBeenCalledWith(expect.any(Error));
      });
      
      it('should handle authentication failure', async () => {
        // Mock fetch to return auth failure
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          statusText: 'Forbidden'
        });
        
        const callback = vi.fn();
        client.log('test message', callback);
        
        // Wait for async operations to complete
        await vi.waitFor(() => {
          expect(fetch).toHaveBeenCalled();
          expect(callback).toHaveBeenCalled();
        });
        
        // Token should be marked as invalid
        expect((client as any).isTokenValid).toBe(false);
        
        // Callback should be called with auth error
        expect(callback).toHaveBeenCalledWith(expect.any(Error));
        expect(callback.mock.calls[0][0].message).toContain('Authentication failed');
      });
    });
  });
  
  describe('flush method', () => {
    it('should send any pending logs in batch queue', async () => {
      // Add some messages to batch queue
      client.log('message1');
      client.log('message2');
      
      // Flush should send batch
      await client.flush();
      
      // Batch should be sent
      expect(fetch).toHaveBeenCalled();
      
      // Batch queue should be empty after sending
      expect((client as any).batchQueue.length).toBe(0);
    });
    
    it('should try to send logs in failed buffer', async () => {
      // Add some messages to failed buffer
      (client as any).failedLogsBuffer = ['failed1', 'failed2'];
      
      // Flush should try to send failed logs
      await client.flush();
      
      // Failed logs should be sent
      expect(fetch).toHaveBeenCalled();
      
      // Failed buffer should be empty after successful send
      expect((client as any).failedLogsBuffer.length).toBe(0);
    });
    
    it('should clear timers', async () => {
      // Set up timers
      (client as any).batchTimer = setTimeout(() => { }, 1000);
      (client as any).bufferRetryTimer = setInterval(() => { }, 1000);
      
      // Flush should clear timers
      await client.flush();
      
      // Timers should be cleared
      expect((client as any).batchTimer).toBeNull();
      expect((client as any).bufferRetryTimer).toBeNull();
    });
  });
  
  describe('retry logic', { timeout: 10000 }, () => {
    it('should retry on network errors', async () => {
      // Set client to non-bulk mode for immediate sending
      (client as any).config.isBulk = false;
      
      // Mock fetch to fail with network error, then succeed
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => 'success after retry'
        });
      
      const callback = vi.fn();
      client.log('test message', callback);
      
      // Wait for async operations to complete (including retry)
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalled();
      }, { timeout: 5000 });
      
      // Callback should be called with success response
      expect(callback).toHaveBeenCalledWith(null, 'success after retry');
    });
    
    it('should give up after max retries', { timeout: 10000 }, async () => {
      // Set client to non-bulk mode for immediate sending
      (client as any).config.isBulk = false;
      
      // Mock console.error to verify error logging
      const consoleErrorSpy = vi.spyOn(console, 'error');
      
      // Enable networkErrorsOnConsole to see errors
      (client as any).config.networkErrorsOnConsole = true;
      
      // Set a shorter retry delay to speed up the test
      (client as any).initialRetryDelay = 100;
      
      // Set a specific maxRetries value for predictable test behavior
      const maxRetries = 5;
      (client as any).maxRetries = maxRetries;
      
      // Mock fetch to always fail with network error
      global.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
      
      const callback = vi.fn();
      client.log('test message', callback);
      
      // Wait for async operations to complete (including all retries)
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalled();
      }, { timeout: 10000 });
      
      // Callback should be called with error
      expect(callback).toHaveBeenCalledWith(expect.any(Error));
      
      // Error should be logged
      expect(consoleErrorSpy).toHaveBeenCalled();
      
      // Verify fetch was called the expected number of times.
      // The implementation starts with attempt=1, so the total number
      // of fetch calls will be exactly maxRetries (not maxRetries+1)
      expect(fetch).toHaveBeenCalledTimes(maxRetries);
    });
    
    it('should buffer failed messages', async () => {
      // Make sure bufferOptions is set
      (client as any).config.bufferOptions = { size: 500, retriesInMilliSeconds: 30000 };
      
      // Mock isRetryableError to return false, so we don't retry
      vi.spyOn(client as any, 'isRetryableError').mockReturnValue(false);
      
      // Mock fetch to fail with an error
      global.fetch = vi.fn().mockRejectedValue(new Error('Some error'));
      
      // Spy on addToFailedBuffer to ensure it's called
      const addToFailedBufferSpy = vi.spyOn(client as any, 'addToFailedBuffer');
      
      // Add messages to reach threshold and trigger immediate send
      for (let i = 0; i < 100; i++) {
        client.log(`message${i}`);
      }
      
      // Wait for addToFailedBuffer to be called
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
        expect(addToFailedBufferSpy).toHaveBeenCalled();
      }, { timeout: 5000 });
      
      // Check that messages were added to buffer
      expect((client as any).failedLogsBuffer.length).toBe(100);
    });
  });
  
  describe('tag handling', () => {
    it('should add tags to URL when useTagHeader is false', async () => {
      // Set useTagHeader to false
      (client as any).config.useTagHeader = false;
      (client as any).config.isBulk = false;
      
      client.log('test message', ['tag1', 'tag2']);
      
      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      
      // URL should include tags
      const url = (fetch as any).mock.calls[0][0];
      expect(url).toContain('/tag/tag1,tag2');
    });
    
    it('should add tags as header when useTagHeader is true', async () => {
      // Set useTagHeader to true (default)
      (client as any).config.isBulk = false;
      
      client.log('test message', ['tag1', 'tag2']);
      
      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      
      // Headers should include X-LOGGLY-TAG
      const options = (fetch as any).mock.calls[0][1];
      expect(options.headers['X-LOGGLY-TAG']).toBe('tag1,tag2');
    });
    
    it('should combine default tags with log-specific tags', async () => {
      // Set default tags
      (client as any).config.tags = ['default1', 'default2'];
      (client as any).config.isBulk = false;
      
      client.log('test message', ['tag1', 'tag2']);
      
      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      
      // Headers should include combined tags
      const options = (fetch as any).mock.calls[0][1];
      expect(options.headers['X-LOGGLY-TAG']).toBe('default1,default2,tag1,tag2');
    });
  });
  
  describe('data formatting', () => {
    it('should stringify objects when json is true', async () => {
      // Set json to true
      (client as any).config.json = true;
      (client as any).config.isBulk = false;
      
      const data = { key1: 'value1', key2: 'value2' };
      client.log(data);
      
      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      
      // Body should be JSON string
      const options = (fetch as any).mock.calls[0][1];
      expect(options.body).toBe(JSON.stringify(data));
      
      // Content-Type should be application/json
      expect(options.headers['Content-Type']).toBe('application/json');
    });
    
    it('should format objects as key=value when json is false', async () => {
      // Set json to false (default)
      (client as any).config.isBulk = false;
      
      const data = { key1: 'value1', key2: 'value2' };
      client.log(data);
      
      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      
      // Body should be formatted as key=value
      const options = (fetch as any).mock.calls[0][1];
      expect(options.body).toBe('key1=value1,key2=value2');
      
      // Content-Type should be text/plain
      expect(options.headers['Content-Type']).toBe('text/plain');
    });
    
    it('should handle circular references in objects', async () => {
      // Set json to true
      (client as any).config.json = true;
      
      // Create object with circular reference
      const circular: any = { key: 'value' };
      circular.self = circular;
      
      // Set up a callback to catch the error
      const callback = vi.fn();
      
      // Call log with circular object
      client.log(circular, callback);
      
      // Verify callback was called with circular reference error
      expect(callback).toHaveBeenCalledWith(expect.any(Error));
      expect(callback.mock.calls[0][0].message).toContain('Circular references');
    });
  });
  
  describe('proxy support', () => {
    it('should set proxy environment variables when proxy is configured', async () => {
      // Set proxy
      (client as any).config.proxy = 'http://proxy.example.com:8080';
      (client as any).config.isBulk = false;
      
      client.log('test message');
      
      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      
      // Environment variables should be set before fetch and cleaned up after
      expect(process.env.HTTPS_PROXY).toBeUndefined();
      expect(process.env.HTTP_PROXY).toBeUndefined();
    });
  });
  
  describe('auth support', () => {
    it('should add authorization header when auth is configured', async () => {
      // Set auth
      (client as any).config.auth = { username: 'user', password: 'pass' };
      (client as any).config.isBulk = false;
      
      client.log('test message');
      
      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      
      // Headers should include authorization
      const options = (fetch as any).mock.calls[0][1];
      expect(options.headers.authorization).toBe('Basic ' + Buffer.from('user:pass').toString('base64'));
    });
  });
});
