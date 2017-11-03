## Why
Do you like to write paths in ```jest.mock()``` calls? I don't. If you don't like too, then you're in the right place. Probably.

The following input:
```js
    import A from "./a";
    import { B } from "./b";
    import * as C from "./c";

    // this is just placeholder for transformation, will be removed from output
    jest.mockObj(A, B, C.C1, C.C2);
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
            "B": "B"
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });
    jest.mock("c", () => {
        const o = {
            "C1": "C1",
            "C2": "C2"
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });

    import A from "./a";
    import { B } from "./b";
    import * as C from "c";

```
Notice that exports were substituted with identifier names. This is very handy for mocking react components in ```ReactTestRenderer``` if you don't want to use shallow renderer.

You can pass implementation for module export too:
```js
    import { B1, B2 } from "./b";

    jest.mockObj(B1, "i'm b");
    jest.mockObj(B2, jest.fn());
```

This will be transformed to:
```js
    jest.mock("./b", () => {
        const o = {
            "B1": "i'm b",
            "B2": jest.fn()
        };
        Object.defineProperty(o, "__esModule", { value: true });
        return o;
    });
```

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

Add to your ```.babelrc```:

```
    "env": {
        "test": {
            plugins: ["jest-easy-mock"]
        }
    }
```

#### Usage with Typescript
Unfortunately TS when compiling to commonjs modules, produces very hard to statically understand structure, so use ```"module": "es2015"``` for output and let babel to transform the output with ```babel-plugin-transform-es2015-modules-commonjs```. Altenatively, you can just use babel for all TS transpilation with preset ```babel-preset-typescript``` and use TS only for editor/IDE purposes.