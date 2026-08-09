export class AiConfigurationError extends Error {
  override name = 'AiConfigurationError';
}

export class AiAnalyzerError extends Error {
  override name = 'AiAnalyzerError';
}

/**
 * Claude CLIが利用上限に達した場合のエラー。
 *
 * 通常の Claude CLI 失敗と区別して後続のClaude呼び出しを止めるために使う。
 * 既存の instanceof AiAnalyzerError による分岐を壊さないよう派生させている。
 */
export class ClaudeUsageLimitError extends AiAnalyzerError {
  override name = 'ClaudeUsageLimitError';
  /** Claude CLIが返した利用上限メッセージ。リセット時刻を含む場合がある。 */
  readonly limitMessage: string;

  constructor(limitMessage: string) {
    super(`Claude CLI usage limit reached. ${limitMessage}`);
    this.limitMessage = limitMessage;
  }
}
