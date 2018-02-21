import * as b from "@babel/core";
import * as t from "@babel/types";
import * as bt from "@babel/traverse";

interface PluginConfiguration {
    /**
     * Jest global identifier
     */
    jestIdentifier: string;
    /**
     * Plugin identifiers
     */
    identifiers: string[];
    /**
     * Mock identifiers, tells ignore paths in these identifiers, usually must be jest.mock() and similar
     */
    mockIdentifiers: string[];
    /**
     * Require actual module in mock and mock only specified identifiers
     */
    requireActual: boolean;
}

const defaultConfig: PluginConfiguration = {
    jestIdentifier: "jest",
    mockIdentifiers: ["mock", "doMock", "unmock", "dontMock"],
    identifiers: ["mockObj", "mockFn"],
    requireActual: false,
};

interface ImportDefinition {
    /**
     * Local imported name of the module
     */
    name: string;
    /**
     * Import type
     */
    type: "default" | "namespace" | "import";
}

interface MockDefinition {
    /**
     * Any subproperties of the access object, i.e. with Utils.a.b.c it will contain ["a", "b", "c"]
     */
    subProperties: string[];
    /**
     * Mock implementation expression
     */
    expression: t.Expression;
}

interface ModuleMockDefinition {
    /**
     * Key is the access identifier IN the module, for example import * as Utils, Utils.a -> access identifier is a
     * import { a } -> access identifier is a, import A -> access identifier is default
     */
    [key: string]: Array<{ expression: t.Expression, subProperty?: string }>;
}

interface PluginState {
    /**
     * All import identifiers with module path -> import definitions
     */
    importIdentifiers: Map<string, ImportDefinition[]>;
    /**
     * Mock map, key is the access identifier name, value is the implementation expression
     */
    mocks: Map<string, MockDefinition[]>;
    /**
     * Existing jest mocks or already mocked action creators
     */
    existingJestMocks: string[];
    /**
     * Top-level program instance
     */
    program: bt.NodePath<t.Program>;
    createMockDefinition(node: t.Node, type: "name" | "mock", implementation?: t.Expression): void;
}

export default function plugin({ types: t, template: tmpl }: typeof b, options?: PluginConfiguration): b.PluginObj<PluginState> {
    let config: PluginConfiguration = {
        ...defaultConfig,
        ...options
    };

    /**
     * Check if given call expression is jest mocking call
     *
     * @param node Node to check
     * @returns True if node is jest mock call expression
     */
    const isJestMockCallExpression = (node: t.CallExpression) => {
        if (!t.isMemberExpression(node.callee)) {
            return false;
        }
        const { object, property } = node.callee;
        if (!t.isIdentifier(object) || !t.isIdentifier(property)) {
            return false;
        }
        if (object.name !== config.jestIdentifier || !config.mockIdentifiers.includes(property.name)) {
            return false;
        }
        return true;
    }

    /**
     * Check if given call expression is jest.mockObj call
     */
    const isMockObjCallExpession = (node: t.CallExpression): "name" | "mock" | undefined  => {
        if (!t.isMemberExpression(node.callee)) {
            return undefined;
        }
        const { object, property } = node.callee;
        if (!t.isIdentifier(object) || !t.isIdentifier(property)) {
            return undefined;
        }
        if (object.name === config.jestIdentifier && config.identifiers.includes(property.name)) {
            const name = property.name;
            return name === "mockObj" ? "name" : "mock";
        }
        return undefined;
    }

    const buildArrowFunc = (modulePath?: string) => tmpl(`
        () => {
            ${modulePath ? `const a = require.requireActual("${modulePath}");` : ""}
            const o = OBJECT_EXP;
            Object.defineProperty(o, "__esModule", { value: true });
            return o;
        }
    `);

    /**
     * Create module mock implementation
     */
    const createModuleMockImpl = (path: string, def: ModuleMockDefinition): t.ArrowFunctionExpression => {
        const topLevelProps: t.ObjectProperty[] = [];
        for (const key of Object.keys(def)) {
            const mocks = def[key];
            if (mocks.length === 0) {
                continue;
            }
            // most common case - single module export -> single mock without any deep level mocks
            if (mocks.every(m => !m.subProperty)) {
                // last one overwrites previous
                const lastMock = mocks.slice(-1)[0];
                topLevelProps.push(t.objectProperty(t.stringLiteral(key), lastMock.expression));
                continue;
            } else {
                // Create nested object for any mock one level deep
                const prop = t.objectProperty(
                    t.stringLiteral(key),
                    t.objectExpression(
                        config.requireActual
                            ? [t.spreadElement(t.memberExpression(t.identifier("a"), t.identifier(key))) as any]
                        : []
                    )
                );
                for (const m of mocks) {
                    if (!m.subProperty) {
                        // may overwrite any previous assignment, it's fine
                        prop.value = m.expression;
                    } else {
                        // if mock with subProperty (i.e. Elements.a, where Elements is module export and a is the subProperty), then
                        // create another object expression
                        prop.value = prop.value && t.isObjectExpression(prop.value) ? prop.value : t.objectExpression();
                        // if (config.requireActual) {
                        //     prop.value.properties.push(t.spreadElement(t.identifier(key)) as any);
                        // }
                        prop.value.properties.push(t.objectProperty(t.stringLiteral(m.subProperty), m.expression));
                    }
                }
                if (prop.value) {
                    topLevelProps.push(prop);
                }
            }
        }
        const objExp = t.objectExpression(config.requireActual ? [t.spreadElement(t.identifier("a")), ...topLevelProps] as any : topLevelProps);
        const arrowFunc = buildArrowFunc(config.requireActual ? path : undefined)({ OBJECT_EXP: objExp }) as t.ExpressionStatement;
        return arrowFunc.expression as t.ArrowFunctionExpression;
        // const varDeclaration = t.variableDeclaration("const", [t.variableDeclarator(t.identifier("o"), t.objectExpression(topLevelProps))])

        // return t.arrowFunctionExpression([], t.objectExpression(topLevelProps));
    }

    /**
     * Build jest.mock() expression
     */
    const buildJestMockForModule = (source: string, mocks: ModuleMockDefinition): t.ExpressionStatement => {

        return t.expressionStatement(t.callExpression(

            t.memberExpression(t.identifier(config.jestIdentifier), t.identifier("mock")),
            [
                t.stringLiteral(source),
                createModuleMockImpl(source, mocks)
            ]
        ));
    }

    return {
        pre() {
            this.importIdentifiers = new Map();
            this.existingJestMocks = [];
            this.mocks = new Map();

            this.createMockDefinition = (def, type, impl) => {
                if (!t.isIdentifier(def) && !t.isMemberExpression(def)) {
                    return;
                }
                let lastIdentifier: string | undefined;
                let accessIdentifierName: string | undefined;
                let subIdentifiers: string[] = [];
                if (t.isIdentifier(def)) {
                    // simple identifier, such as Utils
                    accessIdentifierName = def.name;
                    lastIdentifier = def.name;
                } else if (t.isIdentifier(def.property)) {
                    // Utils.a.b.c, we'll extract each level
                    lastIdentifier = def.property.name;
                    let obj = def.object;
                    while (t.isMemberExpression(obj)) {
                        if (t.isIdentifier(obj.property)) {
                            subIdentifiers.unshift(obj.property.name);
                        }
                        obj = obj.object;
                    }
                    if (t.isIdentifier(obj)) {
                        accessIdentifierName = obj.name;
                    }
                    subIdentifiers.push(lastIdentifier);
                }
                if (!lastIdentifier || !accessIdentifierName) {
                    return;
                }
                // create implementation node if not provided, default implementation is to return just the key name
                if (!impl) {
                    // impl = t.stringLiteral(lastIdentifier);
                    impl = type === "name"
                        ? t.stringLiteral(lastIdentifier)
                        : t.callExpression(t.memberExpression(t.identifier("jest"), t.identifier("fn")), []);
                }
                const mockDef = this.mocks.get(accessIdentifierName) || [];
                mockDef.push({
                    expression: impl,
                    subProperties: subIdentifiers
                });
                this.mocks.set(accessIdentifierName, mockDef);
            }
        },
        post() {
            if (!this.program) {
                return;
            }
            if (this.mocks.size === 0 || this.importIdentifiers.size === 0) {
                return;
            }
            for (const [modulePath, importsFromModule] of this.importIdentifiers) {
                if (this.existingJestMocks.includes(modulePath)) {
                    continue;
                }
                const mocksForModule: ModuleMockDefinition = {};
                for (const i of importsFromModule) {
                    // this is the name which will be used in result mock, we need "default" here for default import
                    const moduleIdentifierName = i.type === "default" ? "default" : i.name;
                    // Mocks stored by access identifier, even for default name, so use local imorted name
                    const mocksForModuleIdentifier = this.mocks.get(i.name);

                    if (!mocksForModuleIdentifier || mocksForModuleIdentifier.length === 0) {
                        continue;
                    }
                    if (i.type === "namespace") {
                        // for namespace type we'll need to use first value in subproperties as key for module export, i.e
                        // import * as Utils from "utils"; jest.mockObj(Utils.a) -> "a" is the module export, subProperty undefined
                        // import * as Utils from "utils"; jest.mockObj(Utils.utilsFunctions.a) -> "utilsFunctions" is the module export, subProperty is "a"
                        mocksForModuleIdentifier.forEach(m => {
                            // won't support deep nesting
                            if (m.subProperties.length !== 1 && m.subProperties.length !== 2) {
                                return;
                            }
                            const [key, subProperty] = m.subProperties;
                            const mockArr = mocksForModule[key] || [];
                            mockArr.push({
                                expression: m.expression,
                                subProperty: subProperty
                            });
                            mocksForModule[key] = mockArr;
                        });
                    } else {
                        const mocksArr = mocksForModule[moduleIdentifierName] || [];
                        mocksForModuleIdentifier.forEach(m => {
                            // won't support deep nesting
                            if (m.subProperties.length > 1) {
                                return;
                            }
                            mocksArr.push({
                                expression: m.expression,
                                // import { Components } from "components"; jest.mockObj(Components.MyComp); -> subProperty is "MyComp"
                                subProperty: m.subProperties[0]
                            });
                        });
                        mocksForModule[moduleIdentifierName] = mocksArr;
                    }
                }
                if (Object.keys(mocksForModule).length === 0) {
                    continue;
                }
                // create jest.mock() call
                this.program.node.body.unshift(buildJestMockForModule(modulePath, mocksForModule));
            }
        },
        visitor: {
            Program(path) {
                // store program to avoid parent lookup later
                this.program = path;
            },
            ImportDeclaration(path) {
                // process import declarations, easiest
                const specifiers = path.node.specifiers;
                const moduleIdentifiers = this.importIdentifiers.get(path.node.source.value) || [];
                for (const s of specifiers) {
                    if (t.isImportDefaultSpecifier(s)) {
                        moduleIdentifiers.push({
                            name: s.local.name,
                            type: "default"
                        });
                    } else if (t.isImportNamespaceSpecifier(s)) {
                        moduleIdentifiers.push({
                            name: s.local.name,
                            type: "namespace"
                        });
                    } else if (t.isImportSpecifier(s)) {
                        if (s.imported.name === "default") {
                            moduleIdentifiers.push({ name: s.local.name, type: "default" });
                        } else {
                            moduleIdentifiers.push({ name: s.local.name, type: "import" });
                        }
                    }
                }
                if (specifiers.length > 0) {
                    this.importIdentifiers.set(path.node.source.value, moduleIdentifiers);
                }
            },
            CallExpression(path) {
                const node = path.node;
                const mockType = isMockObjCallExpession(node);
                if (mockType) {
                    const args = node.arguments;
                    const isWithImplementation = args.length === 2 && !t.isIdentifier(args[1]) && !t.isMemberExpression(args[1]);
                    if (isWithImplementation) {
                        const implementationNode = args[1];
                        const firstArg = args[0];
                        if (t.isExpression(implementationNode)) {
                            this.createMockDefinition(firstArg, mockType, implementationNode);
                        }
                    } else {
                        for (const arg of args) {
                            this.createMockDefinition(arg, mockType);
                        }
                    }
                    // remove call
                    path.remove();
                } else if (isJestMockCallExpression(node)) {
                    // need to remember existing jest.mock() and jest.doMock() to prevent mocking them again
                    const firstArg = node.arguments[0];
                    // jest.mock() requires string literal as first arg
                    if (!firstArg || !t.isStringLiteral(firstArg)) {
                        return;
                    }
                    this.existingJestMocks.push(firstArg.value);
                }
            }
        }
    }
}
