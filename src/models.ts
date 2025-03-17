export interface BufferOptions {
  /** Buffer size (default: 500) */
  size: number;
  /** Retry interval in milliseconds (default: 30000) */
  retriesInMilliSeconds: number;
}

export interface AuthOptions {
  /** The username for the Loggly account */
  username: string;
  /** The password for the Loggly account */
  password: string;
}

/**
 * Configuration options for the Loggly client
 */
export interface LogglyConfig {
  /** Loggly API token for authentication */
  token: string;
  /** Your Loggly subdomain */
  subdomain: string;
  /** Optional custom endpoint URL */
  api?: string;
  /** Optional tags to include with every log message */
  tags?: string[];
  /** Whether to send logs as JSON (default: false) */
  json?: boolean;
  /** Optional proxy URL */
  proxy?: string;
  /** Whether to use bulk endpoint (default: true) */
  isBulk?: boolean;
  /** Custom host for Loggly (default: 'logs-01.loggly.com') */
  host?: string;
  /** Optional auth credentials */
  auth?: AuthOptions;
  /** Whether to use tag header instead of URL path (default: true) */
  useTagHeader?: boolean;
  /** Buffer options for bulk sending */
  bufferOptions?: BufferOptions;
  /** Whether to log network errors to console (default: false) */
  networkErrorsOnConsole?: boolean;
}

/**
 * Represents any loggable data that can be sent to Loggly.
 * Note: Circular references are not supported and will throw an error.
 */
export type LoggableData = string | number | boolean | object | unknown[];

/**
 * Response from the Loggly API
 */
export interface LogglyResponse {
  response: string;
  statusCode: number;
}

/**
 * Callback function type for logging operations
 */
export type LogCallback = (error: Error | null, result?: string | null) => void; 