import type { ModelSecretStorage } from './model-profile-store'

interface SafeStorageApi {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
/** Electron main-process adapter. Linux's hardcoded-password fallback is never accepted. */
export function osSecretStorage(
  storage: SafeStorageApi,
  platform = process.platform,
): ModelSecretStorage {
  const isAvailable = () => {
    try {
      return (
        storage.isEncryptionAvailable() &&
        (platform !== 'linux' ||
          ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
            storage.getSelectedStorageBackend(),
          ))
      )
    } catch {
      return false
    }
  }
  return {
    isAvailable,
    encryptString(value) {
      if (!isAvailable()) throw new Error('Secure storage unavailable')
      return storage.encryptString(value).toString('base64')
    },
    decryptString(value) {
      if (!isAvailable()) throw new Error('Secure storage unavailable')
      return storage.decryptString(Buffer.from(value, 'base64'))
    },
  }
}
