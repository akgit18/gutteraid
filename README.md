Extends the VSCode task interface to allow running tasks from the gutter. Plainly applicable for tests, but nothing stops you from setting whatever scripts you please as run/debug/run with coverage commands

### Setup

Create a JSON file containing extension configuration. The location is `{workspace root}/.gutteraid/patterns.json`. You can also create an optional `patterns.local.json` file in the same directory to override or extend the base configuration with changes that you don't want to commit.

Extension configuration is inspired by VSCode task configuration. Configuration schema is documented at [schemas/patterns.schema.json](https://github.com/akgit18/gutteraid/blob/master/schemas/patterns.schema.json) (and [schemas/patterns.local.schema.json](https://github.com/akgit18/gutteraid/blob/master/schemas/patterns.local.schema.json)), or explained below:

```ts
{
    "version": string // extension version when you wrote the configuration file
    // matchers are uniquely identified by filePattern:taskPattern
    "matchers": [
        {
            "filePattern": string; // Glob pattern for files in which to look. If a file matches multiple matcher filePatterns, the first match will be used.
            "taskPattern": string; // Regex pattern for lines to add task's gutter icons to
            "scripts": [Script, Script, Script] // type Script  = [string, ...string[]] | never[] | undefined. The first script corresponds to Run, the second to Debug, and the third to (Run with) Coverage. 
            "name"?: string; // Name for the task. Shows up when viewing task items in the test explorer. If left undefined, first defaults to the first capturing group, and then to the file uri + line number, if no regex groups were captured by the matcher.
            "terminal"?: 'new' | 'active' | string // Terminal to run the task in--'new' will always spawn a new terminal, 'active' will use the currently open terminal (or spawn a new one if there is none), and any other string will be used as a terminal id (spawning a terminal with that id if there is none). Default is 'active'.
            "killSignal"?: 'dispose' | string // If 'dispose', disposes the terminal when a task is canceled. Otherwise, sends the text to the terminal. Default is '\\u0003' (SIGINT, aka Ctrl-C, stringified). 
        },
    ],
    // inputs are uniquely identified by id
    "inputs": [
        { // basically the same as inputs for tasks.json, but type command is NYI
            "id": string;
            "type": 'promptString' | 'pickString';
            "description"?: string;
            "default"?: string;
            "options"?: string[];
        },
    ]
}
```

Scripts consist of an executable command, followed by its arguments.

The following substitutions will be made for `scripts`:

* `"${group:\d+}"`: The corresponding regex capturing group of the matching line(s) 

* `"${input:<id>}"`: The input with the corresponding id

* `"${vscode:<id>}"`: A vscode variable that can be used in tasks.json.

* Any other string will just be treated as a string

`terminal` will have the same substitutions made. `name` will have the same substitutions made, except for inputs, because the task name must be set before inputs can be gotten from the user.

### Use

Tasks should be found when opening a file that matches the filePattern and contains instances of the taskPattern.

Since this extension heavily relies on the configuration mentioned above, errors in the configuration, such as JSON or RegExp parsing, may prevent it from working properly. Such errors should be logged to the extension's output channel ("GutterAid"). Extra logs will be shown when lowering the log level to Debug or Trace.

### Settings

* `gutteraid.askForInputsEveryTime`
  * Whether to ask for user inputs every time a command is run, or just re-use the previous inputs. If set to false, you can reset inputs for a task by right-clicking the task's icon, revealing it in the test explorer, right clicking it in the test explorer, clicking `Reset task input choices for this task`.
  * Now that you know how to reset previous inputs when you want to change them, I recommend setting this to false.
  * Boolean. Default: `true`

* `gutteraid.alertOnError`
  * Also alert errors that get logged to the extension's output channel.
  * Boolean. Default: `false`

### FAQ

#### Q: Why is this called "GutterAid"?

#### A: The area to the left of the line numbers is called the gutter. This extensions aids you in adding run buttons to the gutter. Thus, GutterAid.
