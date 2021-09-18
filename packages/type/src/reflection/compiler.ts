import {
    __String,
    ArrowFunction,
    Bundle,
    ClassDeclaration,
    ClassElement,
    createCompilerHost,
    createProgram,
    CustomTransformerFactory,
    Declaration,
    ExportDeclaration,
    Expression,
    FunctionDeclaration,
    FunctionExpression,
    getJSDocTags,
    ImportCall,
    ImportDeclaration,
    ImportEqualsDeclaration,
    ImportSpecifier,
    ImportTypeNode,
    InterfaceDeclaration,
    isArrayTypeNode,
    isArrowFunction,
    isClassDeclaration,
    isConstructorDeclaration,
    isEnumDeclaration,
    isExportDeclaration,
    isFunctionDeclaration,
    isFunctionExpression,
    isIdentifier,
    isImportSpecifier,
    isIndexSignatureDeclaration,
    isInterfaceDeclaration,
    isLiteralTypeNode,
    isMappedTypeNode,
    isMethodDeclaration,
    isNamedExports,
    isParenthesizedTypeNode,
    isPropertyDeclaration,
    isPropertySignature,
    isStringLiteral,
    isTypeAliasDeclaration,
    isTypeLiteralNode,
    isTypeReferenceNode,
    isUnionTypeNode,
    ModifierFlags,
    ModuleDeclaration,
    Node,
    NodeFactory,
    NodeFlags,
    PropertyAccessExpression,
    PropertyAssignment,
    QualifiedName,
    ScriptReferenceHost,
    SourceFile,
    Statement,
    SymbolTable,
    SyntaxKind,
    TransformationContext,
    TypeChecker,
    TypeElement,
    TypeLiteralNode,
    TypeNode,
    TypeReferenceNode,
    visitEachChild,
    visitNode
} from 'typescript';
import { ClassType, isArray } from '@deepkit/core';
import { getNameAsString, hasModifier } from './reflection-ast';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import stripJsonComments from 'strip-json-comments';

/**
 * The instruction set.
 * Not more than `packSize` elements are allowed (can be stored).
 */
export enum ReflectionOp {
    end, //requires to be 0. not used explicitly, but a placeholder to detect when the ops are done

    any,
    void,

    string,
    number,
    boolean,
    bigint,

    null,
    undefined,

    /**
     * The literal type of string, number, or boolean.
     *
     * This OP has 1 parameter. The next byte is the absolute address of the literal on the stack, which is the actual literal value.
     *
     * Pushes a function type.
     */
    literal,

    /**
     * This OP pops all types on the current stack frame.
     *
     * This OP has 1 parameter. The next byte is the absolute address of a string|number|symbol entry on the stack.
     *
     * Pushes a function type.
     */
    function,

    /**
     * This OP pops all types on the current stack frame.
     *
     * Pushes a method type.
     */
    method,
    methodSignature, //has 1 parameter, reference to stack for its property name

    /**
     * This OP pops the latest type entry on the stack.
     *
     * Pushes a property type.
     */
    property,
    propertySignature, //has 1 parameter, reference to stack for its property name

    constructor,

    /**
     * This OP pops all types on the current stack frame. Those types should be method|property.
     *
     * Pushes a class type.
     */
    class,

    /**
     * Marks the last entry in the stack as optional. Used for method|property. Equal to the QuestionMark operator in a property assignment.
     */
    optional,

    //modifiers for property|method
    private,
    protected,
    abstract,

    /**
     * This OP has 1 parameter. The next byte is the absolute address of a enum entry on the stack.
     */
    enum,

    set,
    map,

    /**
     * This OP pops all members on the stack frame and pushes a new enum type.
     */
    constEnum,

    /**
     * Pops the latest stack entry and uses it as T for an array type.
     *
     * Pushes an array type.
     */
    array,

    union, //pops frame. requires frame start when stack can be dirty.
    // union2, //pops last 2 types and use as union
    // union3, //pops last 2 types and use as union
    // frameUnion, //pops all types on the current stack frame
    intersection,

    indexSignature,
    objectLiteral,
    mappedType,

    frame, //creates a new stack frame

    //special instructions that exist to emit less output
    date,
    int8Array,
    uint8ClampedArray,
    uint8Array,
    int16Array,
    uint16Array,
    int32Array,
    uint32Array,
    float32Array,
    float64Array,
    bigInt64Array,
    arrayBuffer,
    promise,

    push, //push a reference to the stack
    query, //T['string'], 2 items on the stack
    condition,
    extends, //X extends Y, XY popped from the stack, pushes boolean on the stack
}

const OPs: { [op in ReflectionOp]?: { params: number } } = {
    [ReflectionOp.literal]: { params: 1 },
    [ReflectionOp.propertySignature]: { params: 1 },
};

export const packSizeByte: number = 6;

/**
 * It can't be more ops than this given number
 */
export const packSize: number = 2 ** packSizeByte; //64

export type StackEntry = Expression | (() => ClassType | Object) | string | number | boolean;
export type RuntimeStackEntry = Object | (() => ClassType | Object) | string | number | boolean;

export type Packed = string | [...StackEntry[], string];

function unpackOps(decodedOps: ReflectionOp[], encodedOPs: string): void {
    //the number was so big that it could not handle Number.MAX_SAFE_INTEGER, so it was stored as hex string.
    while (encodedOPs) {
        encodedOPs = encodedOPs.slice(0, -12);
        const ops = parseInt(encodedOPs.slice(-12), 36);
        for (let i = 0; ; i++) {
            const op = (ops / 2 ** (packSizeByte * i)) & (packSize - 1);
            if (op === 0) break;
            decodedOps.push(op);
        }
    }
}

export class PackStruct {
    constructor(
        public ops: ReflectionOp[] = [],
        public stack: StackEntry[] = [],
    ) {
    }
}

/**
 * Pack a pack structure (op instructions + pre-defined stack) and create a encoded version of it.
 */
export function pack(packOrOps: PackStruct | ReflectionOp[]): Packed {
    const ops = isArray(packOrOps) ? packOrOps : packOrOps.ops;

    let packedOp = BigInt(0);
    for (let i = 0; i < ops.length; i++) {
        packedOp += BigInt(ops[i]) * (BigInt(packSize) ** BigInt(i));
    }

    const opNumbers = packedOp.toString(36);

    if (!isArray(packOrOps)) {
        if (packOrOps.stack.length) {
            return [...packOrOps.stack, opNumbers];
        }
    }

    return opNumbers;
}

export function unpack(pack: Packed): { ops: ReflectionOp[], stack: RuntimeStackEntry[] } {
    const ops: ReflectionOp[] = [];
    const stack: StackEntry[] = [];

    if ('string' === typeof pack) {
        unpackOps(ops, pack);
        return { ops, stack };
    }

    const encodedOPs = pack[pack.length - 1];

    //the end has always to be a string
    if ('string' !== encodedOPs) return { ops: [], stack: [] };

    if (pack.length > 1) {
        stack.push(...pack.slice(0, -1) as StackEntry[]);
    }

    unpackOps(ops, encodedOPs);

    return { ops, stack };
}

/**
 * An internal helper that has not yet exposed to transformers.
 */
interface EmitResolver {
    // getReferencedValueDeclaration(reference: Identifier): Declaration | undefined;

    // getReferencedImportDeclaration(nodeIn: Identifier): Declaration | undefined;

    getExternalModuleFileFromDeclaration(declaration: ImportEqualsDeclaration | ImportDeclaration | ExportDeclaration | ModuleDeclaration | ImportTypeNode | ImportCall): SourceFile | undefined;
}

const reflectionModes = ['always', 'default', 'never'] as const;

/**
 * Returns the index of the `entry` in the stack, if already exists. If not, add it, and return that new index.
 */
function findOrAddStackEntry(stack: StackEntry[], entry: any): number {
    const index = stack.indexOf(entry);
    if (index !== -1) return index;
    stack.push(entry);
    return stack.length - 1;
}

function debugPackStruct(pack: PackStruct): void {
    const items: any[] = [];

    for (let i = 0; i < pack.ops.length; i++) {
        const op = pack.ops[i];
        const opInfo = OPs[op];
        items.push(ReflectionOp[op]);
        if (opInfo && opInfo.params > 0) {
            for (let j = 0; j < opInfo.params; j++) {
                const address = pack.ops[++i];
                const entry = pack.stack[address];
                if ('object' === typeof entry && 'getText' in entry) {
                    items.push(entry.getText());
                } else {
                    items.push(entry);
                }
            }
        }
    }

    console.log(...items);
}

function isNodeWithLocals(node: Node): node is (Node & { locals: SymbolTable | undefined }) {
    return 'locals' in node;
}

/**
 * Read the TypeScript AST and generate pack struct (instructions + pre-defined stack).
 *
 * This transformer extracts type and add the encoded (so its small and low overhead) at classes and functions as property.
 *
 * Deepkit/type can then extract and decode them on-demand.
 */
export class ReflectionTransformer {
    sourceFile!: SourceFile;
    protected host!: ScriptReferenceHost;
    protected resolver!: EmitResolver;
    protected f: NodeFactory;

    protected reflectionMode?: typeof reflectionModes[number];

    constructor(
        protected context: TransformationContext,
    ) {
        this.f = context.factory;
        this.host = (context as any).getEmitHost() as ScriptReferenceHost;
        this.resolver = (context as any).getEmitResolver() as EmitResolver;
    }

    protected getTypeCheckerForSource(): TypeChecker {
        const sourceFile: SourceFile = this.sourceFile;
        if ((sourceFile as any)._typeChecker) return (sourceFile as any)._typeChecker;
        const host = createCompilerHost(this.context.getCompilerOptions());
        const program = createProgram([sourceFile.fileName], this.context.getCompilerOptions(), { ...host, ...this.host });
        return (sourceFile as any)._typeChecker = program.getTypeChecker();
    }

    withReflectionMode(mode: typeof reflectionModes[number]): this {
        this.reflectionMode = mode;
        return this;
    }

    transformBundle(node: Bundle): Bundle {
        return node;
    }

    transformSourceFile(sourceFile: SourceFile): SourceFile {
        this.sourceFile = sourceFile;
        const reflection = this.findReflectionConfig(sourceFile);
        if (reflection.mode === 'never') {
            return sourceFile;
        }

        const visitor = (node: Node): any => {
            node = visitEachChild(node, visitor, this.context);

            if (isClassDeclaration(node)) {
                return this.decorateClass(node);
            } else if (isFunctionExpression(node)) {
                return this.decorateFunctionExpression(node);
            } else if (isFunctionDeclaration(node)) {
                return this.decorateFunctionDeclaration(node);
            } else if (isArrowFunction(node)) {
                return this.decorateArrow(node);
            }

            return node;
        };

        this.sourceFile = visitNode(sourceFile, visitor);

        return this.sourceFile;
    }

    protected extractPackStructOfType(node: TypeNode | Declaration, ops: ReflectionOp[], stack: StackEntry[]): void {
        if (isParenthesizedTypeNode(node)) return this.extractPackStructOfType(node.type, ops, stack);

        if (node.kind === SyntaxKind.StringKeyword) {
            ops.push(ReflectionOp.string);
        } else if (node.kind === SyntaxKind.NumberKeyword) {
            ops.push(ReflectionOp.number);
        } else if (node.kind === SyntaxKind.BooleanKeyword) {
            ops.push(ReflectionOp.boolean);
        } else if (node.kind === SyntaxKind.BigIntKeyword) {
            ops.push(ReflectionOp.bigint);
        } else if (node.kind === SyntaxKind.VoidKeyword) {
            ops.push(ReflectionOp.void);
        } else if (node.kind === SyntaxKind.NullKeyword) {
            ops.push(ReflectionOp.null);
        } else if (node.kind === SyntaxKind.UndefinedKeyword) {
            ops.push(ReflectionOp.undefined);
        } else if (isInterfaceDeclaration(node) || isTypeLiteralNode(node)) {
            //interface X {name: string, [indexName: string]: string}
            //{name: string, [indexName: string]: string};
            //for the moment we just serialize the whole structure directly. It's not very efficient if the same interface is used multiple times.
            //In the future we could create a unique variable with that serialized type and reference to it, so its more efficient.

            //extract all members + from all parents
            const members: TypeElement[] = [];

            const extractMembers = (declaration: InterfaceDeclaration | TypeLiteralNode) => {
                for (const member of declaration.members) {
                    const name = getNameAsString(member.name);
                    if (name) {
                        const has = members.some(v => getNameAsString(v.name) === name);
                        if (has) continue;
                    }
                    members.push(member);
                    this.extractPackStructOfType(member, ops, stack);
                }

                if (isInterfaceDeclaration(declaration) && declaration.heritageClauses) {
                    for (const heritage of declaration.heritageClauses) {
                        if (heritage.token === SyntaxKind.ExtendsKeyword) {
                            for (const extendType of heritage.types) {
                                if (isIdentifier(extendType.expression)) {
                                    const resolved = this.resolveDeclaration(extendType.expression);
                                    if (!resolved) continue;
                                    if (isInterfaceDeclaration(resolved.declaration)) {
                                        extractMembers(resolved.declaration);
                                    }
                                }
                            }
                        }
                    }
                }
            };

            extractMembers(node);

            // ops.push(isInterfaceDeclaration(node) ? ReflectionOp.interface : ReflectionOp.objectLiteral);
            ops.push(ReflectionOp.objectLiteral);
            return;
        } else if (isTypeReferenceNode(node)) {
            this.extractPackStructOfTypeReference(node, ops, stack);
        } else if (isArrayTypeNode(node)) {
            this.extractPackStructOfType(node.elementType, ops, stack);
            ops.push(ReflectionOp.array);
        } else if (isPropertySignature(node) && node.type) {
            this.extractPackStructOfType(node.type, ops, stack);
            const name = getNameAsString(node.name);
            ops.push(ReflectionOp.propertySignature, findOrAddStackEntry(stack, name));

        } else if (isConstructorDeclaration(node) && node.type) {
            this.extractPackStructOfType(node.type, ops, stack);
            ops.push(ReflectionOp.constructor);

        } else if (isPropertyDeclaration(node) && node.type) {
            this.extractPackStructOfType(node.type, ops, stack);

            if (node.questionToken) ops.push(ReflectionOp.optional);
            if (hasModifier(node, SyntaxKind.PrivateKeyword)) ops.push(ReflectionOp.private);
            if (hasModifier(node, SyntaxKind.ProtectedKeyword)) ops.push(ReflectionOp.protected);
            if (hasModifier(node, SyntaxKind.AbstractKeyword)) ops.push(ReflectionOp.abstract);

        } else if (isMethodDeclaration(node) || isConstructorDeclaration(node) || isArrowFunction(node) || isFunctionExpression(node) || isFunctionDeclaration(node)) {
            if (node.parameters.length === 0 && !node.type) return;
            for (const parameter of node.parameters) {
                if (parameter.type) {
                    this.extractPackStructOfType(parameter.type, ops, stack);
                }
            }

            if (node.type) {
                this.extractPackStructOfType(node.type, ops, stack);
            } else {
                ops.push(ReflectionOp.any);
            }
            ops.push(isMethodDeclaration(node) || isConstructorDeclaration(node) ? ReflectionOp.method : ReflectionOp.function);
            if (isMethodDeclaration(node)) {
                if (hasModifier(node, SyntaxKind.PrivateKeyword)) ops.push(ReflectionOp.private);
                if (hasModifier(node, SyntaxKind.ProtectedKeyword)) ops.push(ReflectionOp.protected);
                if (hasModifier(node, SyntaxKind.AbstractKeyword)) ops.push(ReflectionOp.abstract);
            }
        } else if (isLiteralTypeNode(node)) {
            if (node.literal.kind === SyntaxKind.NullKeyword) {
                ops.push(ReflectionOp.null);
            } else {
                ops.push(ReflectionOp.literal, findOrAddStackEntry(stack, node.literal));
            }
        } else if (isUnionTypeNode(node)) {

            if (node.types.length === 0) {
                //nothing to emit
                return;
            } else if (node.types.length === 1) {
                //only emit the type
                this.extractPackStructOfType(node.types[0], ops, stack);
            } else {
                if (ops.length) {
                    ops.push(ReflectionOp.frame);
                }

                for (const subType of node.types) {
                    this.extractPackStructOfType(subType, ops, stack);
                }

                ops.push(ReflectionOp.union);
            }
        } else if (isIndexSignatureDeclaration(node)) {
            //node.parameters = first item is {[name: string]: number} => 'name: string'
            if (node.parameters[0].type) {
                this.extractPackStructOfType(node.parameters[0].type, ops, stack);
            } else {
                ops.push(ReflectionOp.any);
            }

            //node.type = first item is {[name: string]: number} => 'number'
            this.extractPackStructOfType(node.type, ops, stack);
            ops.push(ReflectionOp.indexSignature);
        } else {
            ops.push(ReflectionOp.any);
        }
    }

    protected knownClasses: { [name: string]: ReflectionOp } = {
        'Int8Array': ReflectionOp.int8Array,
        'Uint8Array': ReflectionOp.uint8Array,
        'Uint8ClampedArray': ReflectionOp.uint8ClampedArray,
        'Int16Array': ReflectionOp.int16Array,
        'Uint16Array': ReflectionOp.uint16Array,
        'Int32Array': ReflectionOp.int32Array,
        'Uint32Array': ReflectionOp.uint32Array,
        'Float32Array': ReflectionOp.float32Array,
        'Float64Array': ReflectionOp.float64Array,
        'ArrayBuffer': ReflectionOp.arrayBuffer,
        'BigInt64Array': ReflectionOp.bigInt64Array,
        'Date': ReflectionOp.date,
        'String': ReflectionOp.string,
        'Number': ReflectionOp.number,
        'BigInt': ReflectionOp.bigint,
        'Boolean': ReflectionOp.boolean,
    };

    protected resolveDeclaration(e: Node): { declaration: Declaration, importSpecifier?: ImportSpecifier } | undefined {
        if (!isIdentifier(e)) return;

        const typeChecker = this.getTypeCheckerForSource();
        //this resolves the symbol the typeName from the current file. Either the type declaration itself or the import
        const symbol = typeChecker.getSymbolAtLocation(e);

        let declaration: Declaration | undefined = symbol && symbol.declarations ? symbol.declarations[0] : undefined;

        //if the symbol points to a ImportSpecifier, it means its declared in another file, and we have to use getDeclaredTypeOfSymbol to resolve it.
        const importSpecifier = declaration && isImportSpecifier(declaration) ? declaration : undefined;
        if (symbol && (!declaration || isImportSpecifier(declaration))) {
            const resolvedType = typeChecker.getDeclaredTypeOfSymbol(symbol);
            if (resolvedType && resolvedType.symbol && resolvedType.symbol.declarations && resolvedType.symbol.declarations[0]) {
                declaration = resolvedType.symbol.declarations[0];
            } else if (declaration && isImportSpecifier(declaration)) {
                declaration = this.resolveImportSpecifier('Message', declaration.parent.parent.parent);
            }
        }

        if (!declaration) return;

        return { declaration, importSpecifier };
    }

    protected extractPackStructOfTypeReference(type: TypeReferenceNode, ops: ReflectionOp[], stack: StackEntry[]) {
        if (isIdentifier(type.typeName) && this.knownClasses[type.typeName.escapedText as string]) {
            ops.push(this.knownClasses[type.typeName.escapedText as string]);
        } else if (isIdentifier(type.typeName) && type.typeName.escapedText === 'Promise') {
            //promise has always one sub type
            if (type.typeArguments && type.typeArguments[0]) {
                this.extractPackStructOfType(type.typeArguments[0], ops, stack);
            } else {
                ops.push(ReflectionOp.any);
            }
            ops.push(ReflectionOp.promise);
        } else {
            const resolved = this.resolveDeclaration(type.typeName);
            if (!resolved) {
                //we don't resolve yet global identifiers as it's not clear how to resolve them efficiently.
                if (isIdentifier(type.typeName)) {
                    if (type.typeName.escapedText === 'Partial') {
                        //type Partial<T> = {
                        //    [P in keyof T]?: T[P]
                        //};
                        //type Partial<T> = {
                        //    [P in keyof T]?: {[index: string]: T}
                        //};
                        //type Partial<T extends string> = {
                        //    [P in T]: number
                        //};
                    }
                }

                //non existing references are ignored.
                ops.push(ReflectionOp.any);
                return;
            }

            /**
             * For imports that can removed (like a class import only used as type only, like `p: Model[]`) we have
             * to modify the import so TS does not remove it.
             */
            function ensureImportIsEmitted() {
                if (resolved!.importSpecifier) {
                    //make synthetic. Let the TS compiler keep this import
                    (resolved!.importSpecifier as any).flags |= NodeFlags.Synthesized;
                }
            }

            const declaration = resolved.declaration;

            if (isTypeAliasDeclaration(declaration)) {
                //type X = y;
                //we just use the actual value and remove the fact that it came from an alias.
                this.extractPackStructOfType(declaration.type, ops, stack);
            } else if (isMappedTypeNode(declaration)) {
                //<Type>{[Property in keyof Type]: boolean;};
                //todo: how do we serialize that? We need to calculate the actual type and serialize that as ObjectLiteral
                // ops.push(ReflectionOp.mappedType);
                return;
            } else if (isEnumDeclaration(declaration)) {
                ensureImportIsEmitted();
                //enum X {}
                const arrow = this.f.createArrowFunction(undefined, undefined, [], undefined, undefined, isIdentifier(type.typeName) ? type.typeName : this.createAccessorForEntityName(type.typeName));
                ops.push(ReflectionOp.enum, findOrAddStackEntry(stack, arrow));
                return;
            } else if (isClassDeclaration(declaration)) {
                ensureImportIsEmitted();
                // ops.push(type.typeArguments ? ReflectionOp.genericClass : ReflectionOp.class);
                //
                // //todo: this needs a better logic to also resolve references that are not yet imported.
                // // this can happen when a type alias is imported which itself references to a type from another import.
                stack.push(this.f.createArrowFunction(undefined, undefined, [], undefined, undefined, isIdentifier(type.typeName) ? type.typeName : this.createAccessorForEntityName(type.typeName)));

                if (type.typeArguments) {
                    for (const template of type.typeArguments) {
                        this.extractPackStructOfType(template, ops, stack);
                    }
                }

                ops.push(ReflectionOp.class);
            } else {
                this.extractPackStructOfType(declaration, ops, stack);
            }
        }
    }

    protected createAccessorForEntityName(e: QualifiedName): PropertyAccessExpression {
        return this.f.createPropertyAccessExpression(isIdentifier(e.left) ? e.left : this.createAccessorForEntityName(e.left), e.right);
    }

    protected findDeclarationInFile(sourceFile: SourceFile, declarationName: string): Declaration | undefined {
        if (isNodeWithLocals(sourceFile) && sourceFile.locals) {
            const declarationSymbol = sourceFile.locals.get(declarationName as __String);
            if (declarationSymbol && declarationSymbol.declarations && declarationSymbol.declarations[0]) {
                return declarationSymbol.declarations[0];
            }
        }
        return;
    }

    protected resolveImportSpecifier(declarationName: string, importOrExport: ExportDeclaration | ImportDeclaration): Declaration | undefined {
        if (!importOrExport.moduleSpecifier) return;
        if (!isStringLiteral(importOrExport.moduleSpecifier)) return;

        const source = this.resolver.getExternalModuleFileFromDeclaration(importOrExport);
        if (!source) return;

        const declaration = this.findDeclarationInFile(source, declarationName);
        if (declaration) return declaration;

        //not found, look in exports
        for (const statement of source.statements) {
            if (!isExportDeclaration(statement)) continue;

            if (statement.exportClause) {
                //export {y} from 'x'
                if (isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) {
                        //see if declarationName is exported
                        if (element.name.escapedText === declarationName) {
                            const found = this.resolveImportSpecifier(element.propertyName ? element.propertyName.escapedText as string : declarationName, statement);
                            if (found) return found;
                        }
                    }
                }
            } else {
                //export * from 'x'
                //see if `x` exports declarationName (or one of its exports * from 'y')
                const found = this.resolveImportSpecifier(declarationName, statement);
                if (found) {
                    return found;
                }
            }
        }

        return;
    }

    protected getTypeOfType(type: TypeNode | Declaration): Expression | undefined {
        const reflection = this.findReflectionConfig(type);
        if (reflection.mode === 'never') return;

        const packStruct = new PackStruct;
        this.extractPackStructOfType(type, packStruct.ops, packStruct.stack);
        return this.packOpsAndStack(packStruct);
    }

    protected packOpsAndStack(packStruct: PackStruct) {
        if (packStruct.ops.length === 0) return;
        const packed = pack(packStruct);
        debugPackStruct(packStruct);
        return this.valueToExpression(packed);
    }

    protected valueToExpression(value: any): Expression {
        if (isArray(value)) return this.f.createArrayLiteralExpression(value.map(v => this.valueToExpression(v)));
        if ('string' === typeof value) return this.f.createStringLiteral(value, true);
        if ('number' === typeof value) return this.f.createNumericLiteral(value);

        return value;
    }

    /**
     * A class is decorated with type information by adding a static variable.
     *
     * class Model {
     *     static __types = pack(ReflectionOp.string); //<-- encoded type information
     *     title: string;
     * }
     */
    protected decorateClass(classDeclaration: ClassDeclaration): ClassDeclaration {
        const reflection = this.findReflectionConfig(classDeclaration);
        if (reflection.mode === 'never') return classDeclaration;

        const elements: PropertyAssignment[] = [];

        for (const property of classDeclaration.members) {
            const name = property.name ? property.name : isConstructorDeclaration(property) ? 'constructor' : '';
            if (!name) continue;

            //already decorated
            if ('string' === typeof name ? false : isIdentifier(name) ? name.text === '__type' : false) {
                return classDeclaration;
            }

            const encodedType = this.getTypeOfType(property);
            if (!encodedType) continue;
            elements.push(this.f.createPropertyAssignment(name, encodedType));
        }

        if (elements.length === 0) return classDeclaration;

        const types = this.f.createObjectLiteralExpression(elements);
        const __type = this.f.createPropertyDeclaration(undefined, this.f.createModifiersFromModifierFlags(ModifierFlags.Static), '__type', undefined, undefined, types);

        return this.f.updateClassDeclaration(classDeclaration, classDeclaration.decorators, classDeclaration.modifiers,
            classDeclaration.name, classDeclaration.typeParameters, classDeclaration.heritageClauses,
            this.f.createNodeArray<ClassElement>([...classDeclaration.members, __type])
        );
    }

    /**
     * const fn = function() {}
     *
     * => const fn = Object.assign(function() {}, {__type: 34})
     */
    protected decorateFunctionExpression(expression: FunctionExpression) {
        const encodedType = this.getTypeOfType(expression);
        if (!encodedType) return expression;

        const __type = this.f.createObjectLiteralExpression([
            this.f.createPropertyAssignment('__type', encodedType)
        ]);

        return this.f.createCallExpression(this.f.createPropertyAccessExpression(this.f.createIdentifier('Object'), 'assign'), undefined, [
            expression, __type
        ]);
    }

    /**
     * function name() {}
     *
     * => function name() {}; name.__type = 34;
     */
    protected decorateFunctionDeclaration(declaration: FunctionDeclaration) {
        const encodedType = this.getTypeOfType(declaration);
        if (!encodedType) return declaration;

        const statements: Statement[] = [declaration];

        statements.push(this.f.createExpressionStatement(
            this.f.createAssignment(this.f.createPropertyAccessExpression(declaration.name!, '__type'), encodedType)
        ));
        return statements;
    }

    /**
     * const fn = () => { }
     * => const fn = Object.assign(() => {}, {__type: 34})
     */
    protected decorateArrow(expression: ArrowFunction) {
        const encodedType = this.getTypeOfType(expression);
        if (!encodedType) return expression;

        const __type = this.f.createObjectLiteralExpression([
            this.f.createPropertyAssignment('__type', encodedType)
        ]);

        return this.f.createCallExpression(this.f.createPropertyAccessExpression(this.f.createIdentifier('Object'), 'assign'), undefined, [
            expression, __type
        ]);
    }

    protected parseReflectionMode(mode?: typeof reflectionModes[number] | '' | boolean): typeof reflectionModes[number] {
        if ('boolean' === typeof mode) return mode ? 'default' : 'never';
        return mode || 'never';
    }

    protected resolvedTsConfig: { [path: string]: Record<string, any> } = {};

    protected findReflectionConfig(node: Node): { mode: typeof reflectionModes[number] } {
        let current: Node | undefined = node;
        let reflection: typeof reflectionModes[number] | undefined;

        do {
            const tags = getJSDocTags(current);
            for (const tag of tags) {
                if (!reflection && tag.tagName.text === 'reflection' && 'string' === typeof tag.comment) {
                    return { mode: this.parseReflectionMode(tag.comment as any || true) };
                }
            }
            current = current.parent;
        } while (current);

        //nothing found, look in tsconfig.json
        if (this.reflectionMode !== undefined) return { mode: this.reflectionMode };
        let currentDir = dirname(this.sourceFile.fileName);

        while (currentDir) {
            const exists = existsSync(join(currentDir, 'tsconfig.json'));
            if (exists) {
                const tsconfigPath = join(currentDir, 'tsconfig.json');
                try {
                    let tsConfig: Record<string, any> = {};
                    if (this.resolvedTsConfig[tsconfigPath]) {
                        tsConfig = this.resolvedTsConfig[tsconfigPath];
                    } else {
                        let content = readFileSync(tsconfigPath, 'utf8');
                        content = stripJsonComments(content);
                        tsConfig = JSON.parse(content);
                    }

                    if (reflection === undefined && tsConfig.reflection !== undefined) {
                        return { mode: this.parseReflectionMode(tsConfig.reflection) };
                    }
                } catch (error: any) {
                    console.warn(`Could not parse ${tsconfigPath}: ${error}`);
                }
            }
            const next = join(currentDir, '..');
            if (resolve(next) === resolve(currentDir)) break; //we are at root
            currentDir = next;
        }

        return { mode: reflection || 'never' };
    }
}

let loaded = false;
export const transformer: CustomTransformerFactory = (context) => {
    if (!loaded) {
        process.stderr.write('@deepkit/type transformer loaded\n');
        loaded = true;
    }
    return new ReflectionTransformer(context);
};