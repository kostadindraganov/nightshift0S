```markdown
# nightshift0S Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `nightshift0S` TypeScript codebase. It covers file organization, code style, commit conventions, and testing patterns to ensure consistency and maintainability across the project. While no specific framework is detected, the repository follows clear TypeScript best practices and a conventional commit workflow.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `userProfile.ts`, `authService.test.ts`

### Import Style
- Use **relative imports** for referencing local modules.
  - Example:
    ```typescript
    import { getUser } from './userService';
    ```

### Export Style
- Use **named exports** for all modules.
  - Example:
    ```typescript
    // In userService.ts
    export function getUser(id: string) { ... }

    // In another file
    import { getUser } from './userService';
    ```

### Commit Messages
- Follow **conventional commit** format.
- Use the `feat` prefix for new features.
  - Example:
    ```
    feat: add user authentication middleware
    ```
- Average commit message length: ~63 characters.

## Workflows

### Creating a New Feature
**Trigger:** When adding a new feature to the codebase  
**Command:** `/new-feature`

1. Create a new TypeScript file using camelCase naming.
2. Implement the feature using named exports.
3. Write or update corresponding test files (`*.test.ts`).
4. Use relative imports for any dependencies.
5. Commit your changes using the `feat:` prefix and a clear description.
   - Example: `feat: implement password reset functionality`

### Writing Tests
**Trigger:** When adding or updating functionality  
**Command:** `/write-test`

1. Create a test file with the `.test.ts` suffix.
   - Example: `authService.test.ts`
2. Write tests for all exported functions.
3. Use the project's preferred (unknown) testing framework.
4. Run tests to ensure correctness.

## Testing Patterns

- Test files follow the `*.test.ts` pattern.
- Each test file should correspond to a single module or feature.
- Place tests alongside or near the modules they test.
- Testing framework is currently unknown; follow existing patterns in the repository.

## Commands
| Command        | Purpose                                   |
|----------------|-------------------------------------------|
| /new-feature   | Start the workflow for adding a new feature|
| /write-test    | Begin writing or updating tests            |
```
