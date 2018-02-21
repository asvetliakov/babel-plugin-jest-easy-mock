import { transform } from "@babel/core";
import plugin from "./";

it("Doesn't do if there won't be jest.mockObj calls", () => {
    const source = `
        import A from "./a";
        import { B } from "b";

        jest.mock("./a", () => {});
        jest.dontMock("b");
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Creates simple identify mocks", () => {
    const source = `
        import A from "./a";
        import { B, B2 } from "b";
        import { default as C, C2 } from "./c";
        import * as E from "./e";
        import X, { Y } from "./xy";

        jest.mockObj(A, B, C, E.A, E.B, X, Y, B2, C2);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Merges different mockObj calls into single module mock", () => {
    const source = `
        import A from "./a";
        import { B, B2 } from "b";
        import { default as C, C2 } from "./c";
        import * as E from "./e";
        import X, { Y } from "./xy";

        jest.mockObj(A, B);
        jest.mockObj(B2, C);
        jest.mockObj(C2, E.A, E.B);
        jest.mockObj(X);
        jest.mockObj(Y);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Doesn't do anything for namespaced import without any properties", () => {
    const source = `
        import * as E from "./e";

        jest.mockObj(E);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Works with custom mock implementation as second argument", () => {
    const source = `
        import A from "./a";
        import { B, B2 } from "b";
        import { default as C, C2 } from "./c";
        import * as E from "./e";
        import X, { Y } from "./xy";

        jest.mockObj(A, "test");
        jest.mockObj(B2, C2);
        jest.mockObj(B, () => {});
        jest.mockObj(C, jest.fn());

        jest.mockObj(E.A, true);
        jest.mockObj(E.B, X);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Doesn't mock modules which weren't specified in mockObj", () => {
    const source = `
        import A from "./a";
        import { B, B2 } from "b";

        jest.mockObj(B, B2);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Last mock specifier redefines the previous one", () => {
    const source = `
        import A from "./a";
        import { B, B2 } from "b";

        jest.mockObj(A, "test");
        jest.mockObj(A);

        jest.mockObj(B, "test");
        jest.mockObj(B, "test2");
        jest.mockObj(B, "test3");
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
})

it("Works with object access expressions one level deep", () => {
    const source = `
        import A, { ANest } from "./a";
        import { B } from "b";
        import * as C from "c";

        jest.mockObj(A.A1, A.A2, ANest.Nest);
        jest.mockObj(B.B1, "test");
        jest.mockObj(C.C1, C.Nest.Nest1, C.Nest.Nest2);
        jest.mockObj(C.Nest.Nest3, "cnest3");
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Last mocked namespace overwrites nested level mocks", () => {
    const source = `
        import A, { ANest } from "./a";
        import { B } from "b";
        import * as C from "c";

        jest.mockObj(A.A1, A.A2, ANest.Nest);
        jest.mockObj(B.B1, "test");
        jest.mockObj(C.C1, C.Nest.Nest1, C.Nest.Nest2);
        jest.mockObj(C.Nest.Nest3, "cnest3");

        jest.mockObj(A);
        jest.mockObj(C.Nest, jest.fn());
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Ignores 2 or more access levels for non namespaced imports and 3 or more access levels for namespaced imports", () => {
    const source = `
        import A, { ANest } from "./a";
        import { B } from "b";
        import * as C from "c";

        jest.mockObj(A.ANest.A1, A.A2);
        jest.mockObj(B.BNest.B1, "test");
        jest.mockObj(C.Nest1.C1, C.Nest1.C1.A1, C.Nest2.C2.C2);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Doesnt print any module mocks which have already been mocked by jest", () => {
    const source = `
        import A, { ANest } from "./a";
        import { B } from "b";
        import * as C from "c";

        jest.mock("./a");
        jest.unmock("c");

        jest.mockObj(A, ANest, C.A, B);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Puts mock after 'use strict' statement", () => {
    const source = `
        "use strict";
        import A, { ANest } from "./a";
        import { B } from "b";
        import * as C from "c";

        jest.mockObj(A, ANest, C.A, B);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Ignores identifiers without imports", () => {
    const source = `
        import A from "./a";

        jest.mockObj(A, ANest, C.A, B);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});

it("Creates jest.fn() mocks", () => {
    const source = `
        import A from "./a";
        import { B, B2 } from "b";
        import { default as C, C2 } from "./c";
        import * as E from "./e";
        import X, { Y } from "./xy";

        jest.mockFn(A, B);
        jest.mockObj(B2, C);
        jest.mockObj(E.A);
        jest.mockFn(C2, E.B);
        jest.mockObj(X);
        jest.mockFn(Y);
    `;

    expect(transform(source, { plugins: [plugin] }).code).toMatchSnapshot();
});