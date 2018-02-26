## Why
Do you like to write paths in ```jest.mock()``` calls? I don't. If you don't like too, then you're in the right place. Probably.

The following input:
```js
    import A from "./a";
    import { B } from "./b";
    import * as C from "./c";

    // this is just placeholder for transformation, will be removed from output
    jest.mockObj(A, C.C1);
    jest.mockFn(B, C.C2);
```
will be transformed to:

```js
    jest.mock("./a", () => {
        const o = {
            "default": "A"
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });
    jest.mock("./b", () => {
        const o = {
            "B": jest.fn().mockName("B"),
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });
    jest.mock("c", () => {
        const o = {
            "C1": "C1",
            "C2": jest.fn().mockName("C.C2"),
        };
        Object.defineProperty(o, "__esModule", { value: true });
        Object.defineProperty(o.C2, "name", { value: "C.C2" });
        return o;
    });

    import A from "./a";
    import { B } from "./b";
    import * as C from "c";

```

You can say you have to write paths in ```import``` calls anyway. But you're wrong if you use IDE/editor with autoimporting feature - just start to write symbol name and you'll get the imported path for free.

## API

### jest.mockObj()

```
jest.mockObj(...args: any[]);
```

Creates string mock with default implementation to return identifier name. Very handy to mock react components for ```ReactTestRenderer```:

```jsx
// comp1.js
import InnerComp from "./inner";
export const Comp = () => <div><InnerComp /></div>;

// comp1.spec.js
import InnerComp from "../inner";
import Comp from "../comp1";

// Easy including with IDE autoimporting
jest.mockObj(InnerComp);

const testRenderer = TestRenderer.create(<Comp />);
expect(testRenderer).toMatchSnapshot(); // <div><InnerComp /></div>
```

You can pass implementation for module export too:
```js
    import { B1, B2 } from "./b";

    jest.mockObj(B1, "i'm b");
    jest.mockObj(B2, () => "test");
```

This will be transformed to:
```js
    jest.mock("./b", () => {
        const o = {
            "B1": "i'm b",
            "B2": () => "test",
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });
```

### jest.mockFn()

*Note* Requires jest 22.0+

```js
jest.mockFn(...args: any[]);
```

Creates ```jest.fn()``` mock calls for specified symbols
```js
    import { B1, B2 } from "./b";

    jest.mockFn(B1, B2);
```

This will be transformed to:
```js
    jest.mock("./b", () => {
        const o = {
            "B1": jest.fn().mockName("B1"),
            "B2": jest.fn().mockName("B2"),
        };
        Object.defineProperty(o, "__esModule", { value: true });
        Object.defineProperty(o.B1, "name", { value: "B1" });
        Object.defineProperty(o.B2, "name", { value: "B2" });
        return o;
    });
```


### Partial mocking (experimental)

Given some file:

```js
export function func1() { return "func1"; }
export function func2() { return "func2"; }
export const a = "a";
```

Want to mock only ```func1``` but leave original behavior for ```func2/a``` ? It's possible, put into your babel configuration:
```json
    plugins: [["jest-easy-mock", { requireActual: true }]]
```

And following test file:

```js
import { func1, func2, a } from "./a";
jest.mockObj(func1, () => "test");

func1(); // test
func2(); // func2
console.log(a); // a
```

will be transformed to:

```js
    jest.mock("./a", () => {
        const a = require.requireActual("./a");

        const o = {
            ...a,
            func1: () => "test",
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });

```
You need either spread transform enabled in the babel conf, or node 8.4+




Nesting is being supported for one level deep from module export:
```js
    import A, { A2 } from "./a";
    import * as C from "c";

    jest.mockObj(A.ANest, C.Components.Comp1);
    jest.mockObj(A2.A2Nest, jest.fn().mockReturnValue("someval")); // declarations from the same module will be merged into one module mock
```
will result to:
```js
    jest.mock("./a", () => {
        const o = {
            "default": {
                "ANest": "ANest"
            },
            "A2": {
                "A2Nest": jest.fn().mockReturnValue("someval");
            }
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });
    jest.mock("c", () => {
        const o = {
            "Components": {
                "Comp1": "Comp1"
            }
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });

    import A, { A2 } from "./a";
    import * as C from "c";
```

For explicit module mocks with ```jest.mock```, ```jest.doMock```, ```jest.unmock``` and ```jest.dontMock``` the transformation will be ignored:
```js
    import { A } from "a";

    jest.mock("a");
    // the order doesn't matter
    jest.mockObj(A);
```
will be transformed to:
```js
    import { A } from "a";

    jest.mock("a");
```


### Installation

```npm install babel-plugin-jest-easy-mock --save-dev```

Add to your ```.babelrc``` or in ```.babelrc.js```:

```
    plugins: ["jest-easy-mock"]
```


### Configuration

Plugin exposes few configuration options:

```jestIdentifier``` - Jest identifier used to create actual mocks

```requireActual``` - Do ```require.requireActual``` for partial module mocks

```ignoreIdentifiers``` - List of call expression identifiers to ignore the mocking

```identfiers``` - List of call identifiers configuration to do the mocking

```ts
interface IdentifierConfiguration {
    /**
     * Identifier name
     */
    name: string;
    /**
     * Remove identifier from transpilation output
     */
    remove: boolean;
    /**
     * Identifier type. "name" will mock with import name, "mock" will mock with jest.fn()
     */
    type: "name" | "mock",
}
```

Default config:

```js
{
    jestIdentifier: "jest",
    mockIdentifiers: ["jest.mock", "jest.doMock", "jest.unmock", "jest.dontMock"],
    identifiers: [
        {
            name: "jest.mockObj",
            remove: true,
            type: "name",
        },
        {
            name: "jest.mockFn",
            remove: true,
            type: "mock",
        }
    ],
    requireActual: false,
}
```

To pass custom conviguration add to your babelrc/baberc.js:

```json
    "plugins": [
        ["jest-easy-mock", {
            "requireActual": true,
            "identifiers": [
                {
                    "name": "a.b.c",
                    "type": "mock",
                    "remove": false
                },
                {
                    "name": "jest.mockObj",
                    "type": "name",
                    "remove": true
                }
            ]
        }]
    ]
```

#### Usage with Typescript
Unfortunately TS when compiling to commonjs modules, produces very hard to statically understand structure, so use ```"module": "es2015"``` for output and let babel to transform the output with ```babel-plugin-transform-es2015-modules-commonjs```. Altenatively, you can just use babel for all TS transpilation with preset ```babel-preset-typescript``` and use TS only for editor/IDE purposes.