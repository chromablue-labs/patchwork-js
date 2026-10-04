## What changed

Which package, and what.

## Why

## Checks

- [ ] `bun run check` passes (build, typecheck, test)
- [ ] `npm pack --dry-run` in the changed package ships what it should
- [ ] New behaviour has a test that fails without the change

## Compatibility

- [ ] No breaking change to an exported type or function, or the version reflects it
- [ ] `@usepatchwork/react` still builds against the `@usepatchwork/client` version it declares
