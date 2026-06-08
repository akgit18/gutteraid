## [Unreleased]

### Definitely planned improvements:

### Possible future improvements:

- Automated testing for this repo
- Command inputs
- Commands run using the shell of choice, not just whatever default terminal shell is
- Control over match options
- Hotkey to run task on/near given line
- Identification of children tasks (for describes and the like)
- Multiple match files in the same task definition
- Multiple matchers in the same file with conflict resolution
- Multiple QuickPick selections

## [Prerelease]

### Added

- Support lineStart as an additional VSCode variable

## [0.0.2] - 2026-01-21

- Increase discoverability & convenience of input choice caching
  - Add input reset menu item to gutter icon menu
  - Add modal recommending enabling caching if menu item is clicked while caching is disabled
- Improve running commands
  - Escape arguments based on the detected shell
  - Prefix PowerShell commands with & (see [#1](https://github.com/akgit18/gutteraid/issues/1))
  - Attempt shell detection through more than just process.platform
  - Use shellExecution to get command exit code, if possible
- Fix logging
  - Output to dedicated `GutterAid` channel

## [0.0.1] - 2025-09-23

- Initial release
