// Ambient augmentation: `FileSystemFileHandle.createSyncAccessHandle`/`.move()` and
// `FileSystemSyncAccessHandle` are not in TypeScript's `lib.dom.d.ts` yet (checked: TypeScript
// 6.0.3, this repo's pinned version -- `interface FileSystemFileHandle` there has only
// `createWritable`/`getFile`). No top-level `import`/`export` here (`../virtual.d.ts`'s own
// comment): that would make this file a module, and `declare`-less global augmentation only merges
// into the ambient `FileSystemFileHandle` from `lib.dom.d.ts` when this file is itself a plain
// global script. A program that does not transitively import `opfs.ts` (`tests/browser/pages/
// tsconfig.json`) lists this file directly in its own `include`, the same way it already does for
// `virtual.d.ts`.
//
// Shapes: docs/plan/23-persistence-opfs-and-lifecycle.md step 1 probe (Deviations) -- `move()`'s
// 2-arg form (`move(directory, name)`) is the one every supported browser accepts; the 1-arg form
// (`move(name)`) throws `TypeError: Not enough arguments` in WebKit. Sync access handle
// `read`/`write`/`truncate`/`getSize`/`flush`/`close` are all synchronous per spec (File System
// Standard, "FileSystemSyncAccessHandle").
interface FileSystemSyncAccessHandle {
  read(buffer: Uint8Array, options?: { at: number }): number
  write(buffer: Uint8Array, options?: { at: number }): number
  truncate(newSize: number): void
  getSize(): number
  flush(): void
  close(): void
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>
  /** The 2-arg form only (Decision 3): this repo never calls the spec's 1-arg `move(name)`
   * overload, since WebKit rejects it. */
  move(directory: FileSystemDirectoryHandle, name: string): Promise<void>
}
