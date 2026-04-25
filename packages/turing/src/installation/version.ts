declare global {
  const TURING_VERSION: string
  const TURING_CHANNEL: string
}

export const InstallationVersion = typeof TURING_VERSION === "string" ? TURING_VERSION : "local"
export const InstallationChannel = typeof TURING_CHANNEL === "string" ? TURING_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
