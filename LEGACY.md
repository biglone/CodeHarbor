# Legacy Components

CodeHarbor currently ships with two implementations:

- Primary runtime (active): TypeScript/Node (`src/`)
- Legacy reference (maintenance mode): Python (`app/`, `tests/`)

## Policy

- New features and bug fixes must be implemented in the TypeScript runtime first.
- Python legacy code is kept for reference and fallback validation only.
- CI/release gates run against the TypeScript runtime.

## Optional Legacy Check

```bash
npm run test:legacy
```
