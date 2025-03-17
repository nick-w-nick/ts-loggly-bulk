import { LogglyConfig, LoggableData, LogglyResponse, LogCallback } from './models.js';
import { EventEmitter } from 'node:events';

// Maximum event size (1MB)
const EVENT_SIZE = 1000 * 1000;

/**
 * Client for sending logs to Loggly's bulk endpoint
 */
export class LogglyClient extends EventEmitter {
  private readonly config: LogglyConfig;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly requestTimeout: number;
  
  // Batching and buffering properties
  private batchQueue: string[] = [];
  private failedLogsBuffer: string[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private bufferRetryTimer: NodeJS.Timeout | null = null;
  private isTokenValid = true;
  private eventId = 1;
  
  // Retry configuration
  private readonly maxRetries = 5;
  private readonly initialRetryDelay = 2000; // 2 seconds
  
  constructor(config: LogglyConfig) {
    super(); // Initialize EventEmitter
    
    this.validateConfig(config);
    
    // Set defaults while preserving provided values
    this.config = {
      // Required fields (validated above)
      token: config.token,
      subdomain: config.subdomain,
      
      // Optional fields with defaults
      host: config.host ?? 'logs-01.loggly.com',
      api: config.api || 'apiv2',
      json: config.json ?? false,
      useTagHeader: config.useTagHeader ?? true,
      isBulk: config.isBulk ?? true,
      bufferOptions: config.bufferOptions ?? { size: 500, retriesInMilliSeconds: 30000 },
      networkErrorsOnConsole: config.networkErrorsOnConsole ?? false,
      
      // Optional fields without defaults
      tags: config.tags,
      proxy: config.proxy,
      auth: config.auth,
    };
    
    // Set up user agent string
    this.userAgent = 'ts-loggly-bulk';
    this.requestTimeout = 30000;
    // Construct the base URL using all relevant options
    this.baseUrl = this.constructBaseUrl();
    
    // Start buffer retry timer if buffer options are provided
    if (this.config.bufferOptions) {
      this.startBufferRetryTimer();
    }
  }
  
  private constructBaseUrl(): string {
    // Construct endpoint using subdomain if custom endpoint not provided
    const endpoint = `https://${this.config.host}`;
    
    // Use bulk or inputs endpoint based on config
    const path = this.config.isBulk ? 'bulk' : 'inputs';
    
    return `${endpoint}/${path}/${this.config.token}`;
  }
  
  /**
   * Sends log data to Loggly
   * @param data - The data to log
   * @param tags - Optional tags to attach to this specific log
   * @param callback - Optional callback function
   * @returns this - For method chaining
   */
  public log(
    data: LoggableData,
    tags?: string[] | LogCallback,
    callback?: LogCallback
  ): this {
    // Handle case where tags is actually the callback
    if (!callback && typeof tags === 'function') {
      callback = tags;
      tags = undefined;
    }
    
    try {
      if (!this.isTokenValid) {
        if (callback) callback(new Error('Invalid token - authentication failed'));
        return this;
      }
      
      // Format the data
      let formattedData: string;
      
      // Check if we're in bulk mode
      if (this.config.isBulk && Array.isArray(data)) {
        formattedData = (data as LoggableData[]).map(item => this.formatLogData(item)).join('\n');
      } else {
        formattedData = this.formatLogData(data);
      }
      
      // Check message size and truncate if needed
      const truncated = this.truncateLargeMessage(formattedData);
      formattedData = truncated.message;
      
      if (truncated.isMessageTruncated && this.config.networkErrorsOnConsole) {
        console.warn('Message truncated because it exceeds 1MB');
      }
      
      if (this.config.isBulk) {
        // Add to batch queue for bulk sending
        this.addToBatchQueue(formattedData);
        // calling the callback with null args purely for parity with the original node-loggly code
        if (callback) callback(null, null);
      } else {
        // Use an IIFE to emulate fire and forget to handle the non-bulk case
        (async () => {
          try {
            // Send immediately for non-bulk mode WITH RETRY
            const response = await this.sendWithRetry(formattedData, Array.isArray(tags) ? tags : []);
            
            // Match the original code's behavior:
            // Only emit and call callback on successful response with body
            if (response && response.statusCode === 200) {
              this.emit('log', response.response);
              if (callback) callback(null, response.response);
            } else {
              // Log error as in the original code
              console.error(`Error sending log to Loggly: ${response.statusCode}`);
            }
          } catch (error) {
            if (callback) {
              callback(new Error(`Unspecified error from Loggly: ${error}`));
            }
          }
        })();
      }
    } catch (error) {
      if (callback) {
        callback(new Error(`Unspecified error from Loggly: ${error}`));
      }
    }
    
    return this;
  }
  
  /**
   * Truncates messages larger than 1MB
   */
  private truncateLargeMessage(message: string): { message: string; isMessageTruncated: boolean } {
    const bytesLength = Buffer.byteLength(message);
    const isMessageTruncated = bytesLength > EVENT_SIZE;
    
    if (isMessageTruncated) {
      return {
        message: message.slice(0, EVENT_SIZE),
        isMessageTruncated: true
      };
    }
    
    return {
      message,
      isMessageTruncated: false
    };
  }
  
  /**
   * Adds a log message to the batch queue and triggers sending if threshold is reached
   */
  private addToBatchQueue(message: string): void {
    this.batchQueue.push(message);
    
    // Start timer if not already running
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.sendBatch(), 5000);
    }
    
    // Send immediately if batch size threshold is reached
    if (this.batchQueue.length >= 100) {
      this.sendBatch();
    }
  }
  
  /**
   * Sends the current batch of messages
   */
  private async sendBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    
    if (this.batchQueue.length === 0) {
      return;
    }
    
    const batchId = this.eventId++;
    const messages = [...this.batchQueue];
    this.batchQueue = [];
    
    try {
      const batchData = messages.join('\n');
      const response = await this.sendWithRetry(batchData, undefined, batchId);
      
      // Emit log event for successful batch
      this.emit('log', response);
    } catch (error) {
      // Add failed messages to buffer
      this.addToFailedBuffer(messages);
      
      if (this.config.networkErrorsOnConsole) {
        console.error(`Failed to send batch #${batchId}:`, error);
      }
    }
  }
  
  /**
   * Adds failed messages to the buffer, respecting buffer size limits
   */
  private addToFailedBuffer(messages: string[]): void {
    if (!this.config.bufferOptions) {
      return;
    }
    
    const bufferSize = this.config.bufferOptions.size;
    
    // If adding these messages would exceed buffer size, remove oldest messages
    if (this.failedLogsBuffer.length + messages.length > bufferSize) {
      const overflow = (this.failedLogsBuffer.length + messages.length) - bufferSize;
      if (overflow > 0 && overflow <= this.failedLogsBuffer.length) {
        this.failedLogsBuffer = this.failedLogsBuffer.slice(overflow);
      } else if (overflow > this.failedLogsBuffer.length) {
        // If overflow is larger than current buffer, just clear it
        this.failedLogsBuffer = [];
        // And only take the newest messages that will fit
        messages = messages.slice(Math.max(0, messages.length - bufferSize));
      }
    }
    
    this.failedLogsBuffer.push(...messages);
  }
  
  /**
   * Starts the timer to retry sending buffered logs
   */
  private startBufferRetryTimer(): void {
    if (!this.config.bufferOptions || this.bufferRetryTimer) {
      return;
    }
    
    const retryInterval = this.config.bufferOptions.retriesInMilliSeconds;
    
    this.bufferRetryTimer = setInterval(() => {
      this.retryFailedLogs();
    }, retryInterval);
  }
  
  /**
   * Attempts to resend logs from the failed logs buffer
   */
  private async retryFailedLogs(): Promise<void> {
    if (this.failedLogsBuffer.length === 0 || !this.isTokenValid) {
      return;
    }
    
    // Take a batch of logs from the buffer
    const batchSize = this.config.isBulk ? 100 : 1;
    const batch = this.failedLogsBuffer.slice(0, batchSize);
    
    try {
      const batchData = this.config.isBulk ? batch.join('\n') : batch[0];
      const response = await this.sendToLoggly(batchData);
      
      if (response.statusCode === 200) {
        // Remove successfully sent logs from buffer
        this.failedLogsBuffer = this.failedLogsBuffer.slice(batchSize);
        
        // Emit log event for successful retry
        this.emit('log', response);
        
        if (this.config.networkErrorsOnConsole) {
          console.log(`Successfully resent ${batch.length} buffered logs`);
        }
        
        // Continue sending if there are more logs in the buffer
        if (this.failedLogsBuffer.length > 0) {
          setTimeout(() => this.retryFailedLogs(), 1000);
        }
      }
    } catch (error) {
      if (this.config.networkErrorsOnConsole) {
        console.error('Failed to resend buffered logs:', error);
      }
    }
  }
  
  /**
   * Sends data to Loggly with retry logic
   */
  private async sendWithRetry(
    data: string,
    tags?: string[],
    eventId?: number,
    attempt = 1,
    delay = this.initialRetryDelay
  ): Promise<LogglyResponse> {
    try {
      const response = await this.sendToLoggly(data, tags);
      
      if (eventId && attempt > 1 && this.config.networkErrorsOnConsole) {
        console.log(`Log #${eventId} sent successfully after ${attempt} attempts`);
      }
      
      return response;
    } catch (error) {
      const err = error as Error;
      
      // Check if we've reached max retries
      if (attempt >= this.maxRetries) {
        if (this.config.networkErrorsOnConsole) {
          console.error(`Failed log #${eventId} after ${attempt} retries:`, err.message);
        }
        throw err;
      }
      
      // Check for specific network errors that warrant retry
      const shouldRetry = this.isRetryableError(err);
      
      if (!shouldRetry) {
        throw err;
      }
      
      if (eventId && this.config.networkErrorsOnConsole) {
        console.log(`Log #${eventId} - Retry attempt ${attempt + 1} in ${delay}ms`);
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Retry with exponential backoff
      return this.sendWithRetry(data, tags, eventId, attempt + 1, delay * 2);
    }
  }
  
  /**
   * Determines if an error is retryable
   */
  private isRetryableError(error: Error): boolean {
    // Network errors that should be retried
    const retryableErrors = [
      'ETIMEDOUT',
      'ECONNRESET',
      'ESOCKETTIMEDOUT',
      'ECONNABORTED',
      'ENETUNREACH',
      'EHOSTUNREACH'
    ];
    
    // Check if error or its cause contains any of these codes
    const errorString = error.toString();
    const hasRetryableCode = retryableErrors.some(code => errorString.includes(code));
    
    // Also retry on 429 (Too Many Requests) and 5xx server errors
    const isServerError = errorString.includes('status: 5') || errorString.includes('status: 429');
    
    return hasRetryableCode || isServerError;
  }
  
  private validateConfig(config: LogglyConfig): void {
    if (!config.token) {
      throw new Error('options.token is required');
    }
    if (!config.subdomain) {
      throw new Error('options.subdomain is required');
    }
    
    if (config.bufferOptions) {
      if (!config.bufferOptions.size) {
        throw new Error('options.bufferOptions.size is required when bufferOptions is provided');
      }
      if (!config.bufferOptions.retriesInMilliSeconds) {
        throw new Error('options.bufferOptions.retriesInMilliSeconds is required when bufferOptions is provided');
      }
    }
  }
  
  private formatLogData(data: LoggableData): string {
    if (this.config.json) {
      try {
        return JSON.stringify(data);
      } catch (error) {
        if (error instanceof TypeError && error.message.includes('circular')) {
          throw new Error(
            'Circular references detected in log data. Please ensure your log data does not contain circular references.'
          );
        }
        throw error;
      }
    }
    
    if (typeof data === 'object' && data !== null) {
      // Convert shallow objects to Loggly's recommended string format
      return Object.entries(data)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');
    }
    
    return String(data);
  }
  
  /**
   * Sends data to Loggly
   */
  private async sendToLoggly(
    data: string,
    additionalTags?: string[]
  ): Promise<LogglyResponse> {
    const tags = [...(this.config.tags || []), ...(additionalTags || [])];
    let url = this.baseUrl;
    
    // Add tags to URL if present and not using tag header
    if (!this.config.useTagHeader && tags.length > 0) {
      url += `/tag/${tags.join(',')}`;
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);
    
    const headers: Record<string, string> = {
      'accept': '*/*',
      'Content-Type': this.config.json ? 'application/json' : 'text/plain',
      'User-Agent': this.userAgent
    };
    
    // Add tags as header if configured to use tag header
    if (this.config.useTagHeader && tags.length > 0) {
      headers['X-LOGGLY-TAG'] = tags.join(',');
    }
    
    // Add auth if provided
    if (this.config.auth) {
      const authStr = `${this.config.auth.username}:${this.config.auth.password}`;
      headers.authorization = `Basic ${Buffer.from(authStr).toString('base64')}`;
    }
    
    const fetchOptions: RequestInit = {
      method: 'POST',
      body: data,
      headers,
      signal: controller.signal,
    };
    
    // Add proxy support if configured
    // NOTE: This implementation has limitations:
    // 1. Uses environment variables which could cause issues with concurrent requests
    //    using different proxy settings
    // 2. Basic proxy authentication is supported via the URL (http://user:pass@host:port)
    // 3. Only HTTP/HTTPS proxies are supported
    if (this.config.proxy) {
      process.env.HTTPS_PROXY = this.config.proxy;
      process.env.HTTP_PROXY = this.config.proxy;
    }
    
    try {
      const response = await fetch(url, fetchOptions);
      
      // Check for auth failure
      if (response.status === 401 || response.status === 403) {
        this.isTokenValid = false;
        throw new Error('Authentication failed - invalid token');
      }
      
      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status}`);
      }
      
      // Clean up environment variables to avoid affecting other requests
      if (this.config.proxy) {
        delete process.env.HTTPS_PROXY;
        delete process.env.HTTP_PROXY;
      }
      
      return {
        response: await response.text(),
        statusCode: response.status,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
  
  /**
   * Flushes any pending logs before application exit
   */
  public async flush(): Promise<void> {
    // Clear any existing timers
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    
    if (this.bufferRetryTimer) {
      clearInterval(this.bufferRetryTimer);
      this.bufferRetryTimer = null;
    }
    
    // Send any pending logs in the batch queue
    if (this.batchQueue.length > 0) {
      try {
        await this.sendBatch();
      } catch (error) {
        if (this.config.networkErrorsOnConsole) {
          console.error('Error flushing batch queue:', error);
        }
      }
    }
    
    // Try to send any logs in the failed buffer
    if (this.failedLogsBuffer.length > 0 && this.isTokenValid) {
      try {
        await this.retryFailedLogs();
      } catch (error) {
        if (this.config.networkErrorsOnConsole) {
          console.error('Error flushing failed logs buffer:', error);
        }
      }
    }
  }
} 