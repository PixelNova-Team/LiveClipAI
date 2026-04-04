export interface PublishOptions {
  videoPath: string
  title: string
  description: string
  tags: string[]
  coverPath?: string
}

export interface PublishResult {
  success: boolean
  publishUrl?: string
  error?: string
}

export interface PublisherPlugin {
  readonly name: string
  readonly label: string
  readonly label_en?: string       // English display name (optional, for metadata)

  /** URL to open for login */
  getLoginUrl(): string

  /** Publish a video clip */
  publish(opts: PublishOptions): Promise<PublishResult>
}
