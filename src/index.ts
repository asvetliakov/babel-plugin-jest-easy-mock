import * as b from "@babel/core";
import * as t from "@babel/types";
import * as bt from "@babel/traverse";

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

interface PluginConfiguration {
    /**
     * Jest global identifier
     */
    jestIdentifier: string;
    /**
     * Plugin identifiers
     */
    identifiers: IdentifierConfiguration[];
    /**
     * Mock identifiers, tells ignore paths in these identifiers, usually must be jest.mock() and similar
     */
    ignoreIdentifiers: string[];
    /**
     * Require actual module in mock and mock only specified identifiers
     */
    requireActual: boolean;
}

const defaultConfig: PluginConfiguration = {
    jestIdentifier: "jest",
    ignoreIdentifiers: ["jest.mock", "jest.doMock", "jest.unmock", "jest.dontMock"],
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
    /**
     * Mock type
     */
    type: "mock" | "name";
}

interface ModuleMockDefinition {
    /**
     * Key is the access identifier IN the module, for example import * as Utils, Utils.a -> access identifier is a
     * import { a } -> access identifier is a, import A -> access identifier is default
     */
    [key: string]: Array<{
        expression: t.Expression,
        subProperty?: string,
        type: "mock" | "name",
        importDef: ImportDefinition,
    }>;
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
    createMockDefinition(node: t.Node, type: "name" | "mock", expName: string, implementation?: t.Expression): void;
}

export default function plugin({ types: t, template: tmpl }: typeof b, options?: PluginConfiguration): b.PluginObj<PluginState> {
    let config: PluginConfiguration = {
        ...defaultConfig,
        ...options
    };

    /**
     * Return full name of member expression
     */
    const getNameOfExpression = (node: any, name: string = ""): string => {
        if (!t.isIdentifier(node) && !t.isMemberExpression(node)) {
            return "";
        }
        if (t.isIdentifier(node)) {
            return name += name ? "." + node.name : node.name;
        }
        const { object, property } = node;
        if (t.isIdentifier(object)) {
            name += name ? "." + object.name : object.name;
        } else if (t.isMemberExpression(object)) {
            name += name ? "." + getNameOfExpression(object) : getNameOfExpression(object);
        }
        if (t.isIdentifier(property)) {
            name += name ? "." + property.name : property.name;
        } else if (t.isMemberExpression(property)) {
            name += name ? "." + getNameOfExpression(property) : getNameOfExpression(property);
        }
        return name;
    }

    /**
     * Check if given call expression is jest mocking call
     *
     * @param node Node to check
     * @returns True if node is jest mock call expression
     */
    const isJestMockCallExpression = (node: t.CallExpression) => {
        if (!t.isIdentifier(node.callee) && !t.isMemberExpression(node.callee)) {
            return false;
        }
        let fullCalle = getNameOfExpression(node.callee);
        if (!fullCalle) {
            return false;
        }
        return !!config.ignoreIdentifiers.find(i => i === fullCalle);
    }

    /**
     * Check if given call expression is jest.mockObj call
     */
    const isMockObjCallExpession = (node: t.CallExpression): IdentifierConfiguration | undefined  => {
        if (!t.isIdentifier(node.callee) && !t.isMemberExpression(node.callee)) {
            return undefined;
        }
        let fullCalle = getNameOfExpression(node.callee);
        if (!fullCalle) {
            return;
        }
        const knownIdentifier = config.identifiers.find(i => i.name === fullCalle);
        if (!knownIdentifier) {
            return;
        }
        return knownIdentifier;
    }

    const buildArrowFunc = (statements: string[], modulePath?: string) => tmpl(`
        () => {
            ${modulePath ? `const a = jest.requireActual("${modulePath}");` : ""}
            const o = OBJECT_EXP;
            Object.defineProperty(o, "__esModule", { value: true });
            ${statements.length > 0 ? statements.join("\n") : ""}
            return o;
        }
    `, { placeholderPattern: false, placeholderWhitelist: new Set(["OBJECT_EXP"]) } as any);

    const buildNameStatement = (key: string, name: string) => `Object.defineProperty(o.${key}, "name", { value: "${name}" });`;

    /**
     * Create module mock implementation
     */
    const createModuleMockImpl = (path: string, def: ModuleMockDefinition): t.ArrowFunctionExpression => {
        const topLevelProps: t.ObjectProperty[] = [];
        const statements: string[][] = [];
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
                if (lastMock.type === "mock") {
                    statements.push([
                        key,
                        lastMock.importDef.type === "default"
                            ? lastMock.importDef.name
                            : lastMock.importDef.type === "namespace" ? `${lastMock.importDef.name}.${key}` : key
                    ]);
                }
                continue;
            } else {
                // Create nested object for any mock one level deep
                const prop = t.objectProperty(
                    t.stringLiteral(key),
                    t.objectExpression([]),
                );
                for (const m of mocks) {
                    if (!m.subProperty) {
                        // may overwrite any previous assignment, it's fine
                        prop.value = m.expression;
                    } else {
                        // if mock with subProperty (i.e. Elements.a, where Elements is module export and a is the subProperty), then
                        // create another object expression
                        prop.value = prop.value && t.isObjectExpression(prop.value) ? prop.value : t.objectExpression([]);
                        // also spread it if required and hasn't spreaded yet
                        if (config.requireActual && prop.value.properties.length === 0) {
                            prop.value.properties.push(t.spreadElement(t.memberExpression(t.identifier("a"), t.identifier(key))) as any)
                        }
                        prop.value.properties.push(t.objectProperty(t.stringLiteral(m.subProperty), m.expression));
                        if (m.type === "mock") {
                            const oName = m.importDef.type === "default" ? `${m.importDef.name}.${m.subProperty}` : `${m.importDef.name}.${key}.${m.subProperty}`;
                            statements.push([`${key}.${m.subProperty}`, oName]);
                        }
                    }
                }
                if (prop.value) {
                    topLevelProps.push(prop);
                }
            }
        }
        const objExp = t.objectExpression(config.requireActual ? [t.spreadElement(t.identifier("a")), ...topLevelProps] as any : topLevelProps);
        const nameStatements = statements
        // Filter out non-existed keys
            .filter(([key]) => {
                const [firstKey, secondKey] = key.split(".");
                const prop = topLevelProps.find(p => (t.isIdentifier(p.key) && p.key.name === firstKey) || (t.isStringLiteral(p.key) && p.key.value === firstKey));
                if (!prop) {
                    return false;
                }
                if (!secondKey) {
                    return true;
                }
                if (!t.isObjectExpression(prop.value)) {
                    return false;
                }
                const oKey = prop.value.properties.find(p =>
                    t.isObjectProperty(p) &&
                    ((t.isStringLiteral(p.key) && p.key.value === secondKey) || (t.isIdentifier(p.key) && p.key.name === secondKey))
                );
                return !!oKey;
            })
            .map(([key, name]) => buildNameStatement(key, name));
        const arrowFunc = buildArrowFunc(nameStatements, config.requireActual ? path : undefined)({ OBJECT_EXP: objExp }) as t.ExpressionStatement;
        return arrowFunc.expression as t.ArrowFunctionExpression;
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

            this.createMockDefinition = (def, type, name, impl) => {
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
                    if (lastIdentifier) {
                        subIdentifiers.push(lastIdentifier);
                    }
                }
                if (!lastIdentifier || !accessIdentifierName) {
                    return;
                }
                // create implementation node if not provided, default implementation is to return just the key name
                if (!impl) {
                    // impl = t.stringLiteral(lastIdentifier);
                    impl = type === "name"
                        ? t.stringLiteral(lastIdentifier)
                        : t.callExpression(
                            t.memberExpression(
                                t.callExpression(t.memberExpression(t.identifier("jest"), t.identifier("fn")), []),
                                t.identifier("mockName"),
                            ),
                            [t.stringLiteral(name)],
                        );
                }
                const mockDef = this.mocks.get(accessIdentifierName) || [];
                mockDef.push({
                    expression: impl,
                    subProperties: subIdentifiers,
                    type: type,
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
                                subProperty: subProperty,
                                type: m.type,
                                importDef: i,
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
                                subProperty: m.subProperties[0],
                                type: m.type,
                                importDef: i,
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
                const mockIdentifier = isMockObjCallExpession(node);
                if (mockIdentifier) {
                    const args = node.arguments;
                    const isWithImplementation = args.length === 2 && !t.isIdentifier(args[1]) && !t.isMemberExpression(args[1]);
                    if (isWithImplementation) {
                        const implementationNode = args[1];
                        const firstArg = args[0];
                        const expName = getNameOfExpression(firstArg);
                        if (!expName && mockIdentifier.type === "mock") {
                            return;
                        }
                        if (t.isExpression(implementationNode)) {
                            this.createMockDefinition(firstArg, mockIdentifier.type, expName, implementationNode);
                        }
                    } else {
                        for (const arg of args) {
                            const expName = getNameOfExpression(arg);
                            if (!expName && mockIdentifier.type === "mock") {
                                continue;
                            }
                            this.createMockDefinition(arg, mockIdentifier.type, expName);
                        }
                    }
                    // remove call
                    if (mockIdentifier.remove) {
                        path.remove();
                    }
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
