/**
 * @blasti/core — Runtime Configuration
 *
 * Controls whether the application runs in cloud or local mode.
 * The mode determines database, auth, and sync behavior.
 */

export interface CoreConfig {
  /** Runtime mode */
  mode: 'cloud' | 'local'

  /** Local API port (only used in local mode) */
  localPort: number

  /** Local API bind address (MUST be localhost only) */
  localBindAddress: string

  /** Database path (local SQLite file path) */
  databasePath?: string

  /** Cloud API base URL (only used in cloud mode) */
  cloudApiUrl?: string

  /** JWT secret for session tokens */
  jwtSecret: string

  /** App version string */
  appVersion: string

  /** Device ID for sync conflict resolution */
  deviceId: string
}

/**
 * Default configuration values.
 */
export const defaultConfig: CoreConfig = {
  mode: 'local',
  localPort: 3111,
  localBindAddress: '127.0.0.1',
  jwtSecret: 'blasti-local-secret',
  appVersion: '1.0.0',
  deviceId: 'local-desktop',
}

/**
 * Create a configuration from environment variables and defaults.
 */
export function createConfig(overrides?: Partial<CoreConfig>): CoreConfig {
  return {
    ...defaultConfig,
    mode: (overrides?.mode || (process.env.BLASTI_MODE as 'cloud' | 'local')) || 'local',
    localPort: overrides?.localPort || parseInt(process.env.BLASTI_LOCAL_PORT || '3111', 10),
    databasePath: overrides?.databasePath || process.env.BLASTI_DB_PATH,
    jwtSecret: overrides?.jwtSecret || process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || defaultConfig.jwtSecret,
    appVersion: overrides?.appVersion || process.env.npm_package_version || defaultConfig.appVersion,
    deviceId: overrides?.deviceId || process.env.BLASTI_DEVICE_ID || defaultConfig.deviceId,
    ...overrides,
  }
}

export function isCloudMode(config: CoreConfig): boolean {
  return config.mode === 'cloud'
}

export function isLocalMode(config: CoreConfig): boolean {
  return config.mode === 'local'
}
