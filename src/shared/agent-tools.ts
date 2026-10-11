/** Trusted main-process definitions. Provider names never dispatch arbitrary application methods. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export interface ToolResult {
  readonly callId: string
  readonly output: unknown
  readonly isError?: boolean
}

/** An uninspectable, single-use capability held only in main-process memory. */
declare const continuationBrand: unique symbol
export interface ToolContinuation {
  readonly [continuationBrand]: true
}

export type NativeToolTurn =
  | { readonly kind: 'final'; readonly text: string }
  | {
      readonly kind: 'tool_calls'
      readonly calls: readonly ToolCall[]
      readonly continuation: ToolContinuation
    }
