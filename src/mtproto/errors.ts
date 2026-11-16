/** Error returned by a Telegram API method (rpc_error). */
export class RpcError extends Error {
  override readonly name = 'RpcError';
  /** Error type without the numeric suffix, e.g. `FLOOD_WAIT` for `FLOOD_WAIT_30`. */
  readonly type: string;
  /** Numeric suffix: seconds for FLOOD_WAIT_X, DC id for *_MIGRATE_X. */
  readonly value?: number;

  constructor(
    readonly code: number,
    readonly errorMessage: string,
    readonly method: string,
  ) {
    super(`${method}: ${code} ${errorMessage}`);
    const m = /^(.*?)_(\d+)$/.exec(errorMessage);
    this.type = m ? m[1] : errorMessage;
    this.value = m ? Number(m[2]) : undefined;
  }

  /** `err.is('PHONE_CODE_INVALID')` / `err.is('FLOOD_WAIT')` */
  is(type: string): boolean {
    return this.errorMessage === type || this.type === type;
  }
}
