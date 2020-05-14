import * as ts from "typescript";

exports.eqIdentifierImpl = function(i1: ts.Identifier) {
  return function(i2: ts.Identifier) {
    return i1 === i2;
  }
}

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: path => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine
};

type Effect<a> = () => a;
type Nullable<a> = a | null;
type TypeParameter<t> = { name: ts.__String, default: Nullable<t> };
type Property<t> = { name: string, type: t, optional: boolean }
type Function<t> = { returnType: t, parameters: { type: t, name: string }[] }
type Result<d> = { topLevel: d[], readDeclaration: (v: ts.Declaration) => Effect<d> }

export function _readDTS<d, t, either>(
  options: {
    compile: boolean,
    debug: boolean,
    strictNullChecks: boolean
  },
  visit: {
    onDeclaration: {
      // can we return fqn
      class_: (x: {
        fullyQualifiedName: string,
        name: string,
        properties: Property<t>[], 
        typeParameters: TypeParameter<t>[]
      }) => d,
      // function: (x: { fullyQualifiedName: string | undefined, returnType: t, parameters: { type: t, name: string }[] }) => d
      interface: (x:
        {
          name: string,
          fullyQualifiedName: string,
          properties: Property<t>[]
          typeParameters: TypeParameter<t>[]
        }) => d
      module_: (x: { fullyQualifiedName: string, declarations: d[] }) => d
      typeAlias: (x: { name: string, type: t, typeParameters: TypeParameter<t>[] }) => d
      unknown: (u: { fullyQualifiedName: Nullable<string>, msg: string }) => d
    },
    onTypeNode: {
      anonymousObject: (properties: ({ fullyQualifiedName: string, properties: Property<t>[] })) => t,
      array: (type: t) => t,
      function: (x: Function<t>) => t, 
      intersection: (types: t[]) => t,
      primitive: (name: string) => t,
      tuple: (types: t[]) => t,
      typeParameter: (tp: TypeParameter<t>) => t,
      typeReference: (i: { typeArguments: t[], fullyQualifiedName: string, ref: Nullable<ts.Declaration> }) => t,
      booleanLiteral: (value: boolean) => t,
      numberLiteral: (value: number) => t,
      stringLiteral: (value: string) => t,
      union: (members: t[]) => t,
      unknown: (err: string) => t
    }
  },
  file: { path: string, source: Nullable<string> },
  either: {
    left: (err : String[]) => either,
    right: (result: Result<d>) => either
  }
): either {
  let sourceFile:ts.SourceFile | undefined = undefined;
  let compilerOptions:ts.CompilerOptions =  {
    target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.CommonJS,
    strictNullChecks: options.strictNullChecks
  };
  let program = createProgram(file, compilerOptions);
  let checker = <MyChecker>program.getTypeChecker();
  let onDeclaration = visit.onDeclaration;
  let onTypeNode = visit.onTypeNode;
  let declarations:d[] = [];

  let log = options.debug?function(msg:any) { console.log(msg); }:function() {};

  if(options.compile) {
    let emitResult = program.emit();
    if(emitResult.emitSkipped) {
      let allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
      let errors:any[] = [];
      allDiagnostics.forEach(function(d) {
        if(d.category === ts.DiagnosticCategory.Error) {
          errors.push(ts.formatDiagnostic(d, formatHost));
        }
      })
      if(errors.length > 0) {
        return either.left(errors);
      }
    }
  }
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile && sf.fileName === file.path) {
      sourceFile = sf;
    }
  }
  if(sourceFile !== undefined) {
    if(!options.compile && sourceFile !== undefined) {
      let x = program.getSyntacticDiagnostics(sourceFile);
      let errors:any[] = [];
      x.forEach(function(d) {
        if(d.category === ts.DiagnosticCategory.Error) {
          errors.push(ts.formatDiagnostic(d, formatHost));
        }
      })
      if(errors.length > 0) {
        return either.left(errors);
      }
    }
    log("Starting iteration")
    ts.forEachChild(sourceFile, function(d) {
      log("Another declaration")
      if (isNodeExported(checker, d))
        declarations.push(visitDeclaration(d));
    });
    log("Ending iteration")
  } else {
    return either.left(["Source file not found"])
  }
  return either.right({
    topLevel: declarations,
    readDeclaration: (v:ts.Declaration) => () => visitDeclaration(v)
  })
  // It is probably better to use some internal checker machinery
  // than to use heuristics like `fullyQualifiedName == "Array"`
  interface MyChecker extends ts.TypeChecker {
    // Hack source:
    // https://github.com/microsoft/TypeScript/blob/v3.6.3/src/compiler/checker.ts
    // I've additionally restricted some signatures.
    getElementTypeOfArrayType: (type: ts.TypeReference) =>  ts.Type | undefined;
    isArrayType: (type: ts.TypeReference) => boolean;
    isTupleType: (type: ts.TypeReference) => boolean;
    isReadonlyArrayType: (type: ts.TypeReference) => boolean;
    getTypeOfPropertyOfType: (type: ts.TypeReference, propertyName: string) => ts.Type | undefined;
    getNullType: () => ts.Type,
    getUndefinedType: () => ts.Type,
    // Some other possible helpers
    // isTupleLikeType: (type: ts.Type) => boolean;
    // isArrayLikeType: (type: ts.Type) => boolean;
    // isEmptyArrayLiteralType: (type: ts.Type) => boolean;
    // isArrayOrTupleLikeType: (type: ts.Type) => boolean;
    // isNeitherUnitTypeNorNever: (type: ts.Type) => boolean;
    // isUnitType: (type: ts.Type) => boolean;
    // isLiteralType: (type: ts.Type) => boolean;
  }

  interface MyNode extends ts.Node {
    name?: ts.Identifier;
  }

  function property(sym: ts.Symbol, dec?: ts.Declaration): Property<t> {
    let optional = (sym.flags & ts.SymbolFlags.Optional) == ts.SymbolFlags.Optional;
    let memType = dec?checker.getTypeOfSymbolAtLocation(sym, dec):checker.getDeclaredTypeOfSymbol(sym);

    log("PROPERTY" + sym.name);
    let t = getTSType(memType);
    return { name: sym.name, type: t, optional }
  }

  function visitDeclaration(node: MyNode): d {
    let processTypeParameters = function ( typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): TypeParameter<t>[] {
      return (!typeParameters)?[]:typeParameters.map(function(p: ts.TypeParameterDeclaration) {
        let d = p.default?getTSType(checker.getTypeAtLocation(p.default)):null;
        return { name: p.name.escapedText, default: d };
      })
    }
    let symbol = node.name?checker.getSymbolAtLocation(node.name):undefined;
    if(symbol) {
      let fullyQualifiedName = checker.getFullyQualifiedName(symbol);
      let nodeType = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
      if(ts.isInterfaceDeclaration(node)) {
        // let typeSignatures = checker.getSignaturesOfType(node, ts.SignatureKind.C);
        // let s = typeSignatures[0]
        // if(s) {
        //   console.log(s.typeParameters);
        //   checker.getReturnTypeOfSignature(s);
        // } else {
        //   console.log("EMPTY signature")

        // }

        let properties = nodeType.getProperties().map((sym: ts.Symbol) => property(sym, node));
        let i = {
          name: symbol.getName(),
          fullyQualifiedName,
          properties,
          typeParameters: processTypeParameters(node.typeParameters)
        };
        return onDeclaration.interface(i);
      } else if(ts.isClassDeclaration(node)) {
        // let properties = nodeType.getProperties().map((sym: ts.Symbol) => property(sym, node));
        let properties = checker.getPropertiesOfType(nodeType).map((sym: ts.Symbol) => property(sym, node));
        let i = {
          // TODO: Extract class name
          name: nodeType.symbol.getName(),
          fullyQualifiedName,
          properties,
          typeParameters: processTypeParameters(node.typeParameters)
        };
        return onDeclaration.class_(i);

      } else if (ts.isTypeAliasDeclaration(node)) {
        log("TYPE ALIAS")
        let nodeType = checker.getTypeAtLocation(node);
        let x = {
          name: node.name.text,
          type: getTSType(nodeType),
          typeParameters: processTypeParameters(node.typeParameters)
        };
        return onDeclaration.typeAlias(x);
      //} else if(ts.isMethodDeclaration(node)) {
      //  // let signature = checker.getSignatureFromDeclaration(node);
      //  log("METHOD Declaration")
      //  log(node.name.toString())
      // } else if(ts.isMethodSignature(node)) {
      //  // let signature = checker.getSignatureFromDeclaration(node);
      //  log("METHOD SIGNATURE")
      //  log(node.name.toString())
      // } else if (ts.isFunctionDeclaration(node)) {
      //   log("Function Declaration - commented out. I'm not sure if I should handle it as typeAlias?")
      //   // let functionType = checker.getTypeAtLocation(node)
      //   // let signature = checker.getSignatureFromDeclaration(node);
      //   // if(signature) {
      //     // return onDeclaration.function({
      //       // fullyQualifiedName: checker.getFullyQualifiedName(functionType.symbol),
      //       // ...functionSignature(signature)
      //     // })
      //   // }
      } else if(ts.isModuleDeclaration(node)) {
        log("Module declaration found:" + node.name);
        // let moduleType = checker.getTypeAtLocation(node.name)
        let declarations:d[] = [];
        // let m = checker.getSymbolAtLocation(moduleType);
        console.log("Iterating module: " + node.name)
        ts.forEachChild(node, function(d){
          if(ts.isModuleBlock(d)) {
            d.statements.forEach(function(s) {
              // XXX: isNodeExported fails in case of ambient modules - why?
              // if (isNodeExported(checker, d)) {
              console.log("")
              declarations.push(visitDeclaration(s));
            });
          }
        })
        return onDeclaration.module_({
            fullyQualifiedName,
            declarations
        });
      }
    }
    let nodeType = checker.getTypeAtLocation(node);
    let fullyQualifiedName = null;
    try {
      fullyQualifiedName = checker.getFullyQualifiedName(nodeType.symbol)
    } catch(e) {
    }
    return onDeclaration.unknown({ fullyQualifiedName, msg: "Unknown declaration node"})
  }

  function getTSType(memType: ts.Type): t {
    // Because we are processing only typelevel
    // declarations we can be sure that
    // these literals are type level entities.
    if(memType.isStringLiteral()) {
      return onTypeNode.stringLiteral(memType.value);
    }
    else if(memType.isNumberLiteral()) {
      return onTypeNode.numberLiteral(memType.value);
    }
    // XXX: I haven't found any other way to access
    // BooleanLiteral value...
    else if((memType.flags & ts.TypeFlags.BooleanLiteral) &&
            ((memType as any).intrinsicName == "true" ||
             (memType as any).intrinsicName == "false" )) {
      if((memType as any).intrinsicName == "true") {
          return onTypeNode.booleanLiteral(true);
      } else {
          return onTypeNode.booleanLiteral(false);
      }
    }
    else if (memType.flags & (ts.TypeFlags.String
            | ts.TypeFlags.BooleanLike | ts.TypeFlags.Number
            | ts.TypeFlags.Null | ts.TypeFlags.VoidLike | ts.TypeFlags.Any)) {
      return onTypeNode.primitive(checker.typeToString(memType));
    }
    else if (memType.isUnion()) {
      let types = memType.types.map(getTSType);
      return onTypeNode.union(types);
    }
    else if (memType.isIntersection()) {
      let types = memType.types.map(getTSType);
      return onTypeNode.intersection(types);
    }
    else if (memType.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) {
      log("Possible object / non primitive type")
      let memObjectType = <ts.ObjectType>memType;
      let onInterfaceReference = function(target: ts.InterfaceType, typeArguments: t[]) {
        let ref = (target.symbol && target.symbol.valueDeclaration)
            ?target.symbol.valueDeclaration
            :(target.symbol && target.symbol.declarations.length === 1)
              ?target.symbol.declarations[0]
              :null;
        let fullyQualifiedName = checker.getFullyQualifiedName(target.symbol);
        return ref
          ?onTypeNode.typeReference({typeArguments, fullyQualifiedName, ref})
          :onTypeNode.unknown("Unable to get type declaration for:" + fullyQualifiedName + "<" + typeArguments + ">")
      }
      if(memObjectType.objectFlags & ts.ObjectFlags.Reference) {
        log("REFERENCE")
        let reference = <ts.TypeReference>memObjectType;
        if(checker.isArrayType(reference)) {
          let elem = checker.getElementTypeOfArrayType(reference);
          if(elem)
            return onTypeNode.array(getTSType(elem));
        }
        if(checker.isTupleType(reference)) {
          let e: string, elem:ts.Type | undefined, elems:t[] = [];
          for(let i=0;; i++) {
            // Hack source:
            // https://github.com/microsoft/TypeScript/blob/v3.6.3/src/compiler/checker.ts + getTupleElementType
            e = "" + i as string;
            elem = checker.getTypeOfPropertyOfType(reference, e);
            if(elem) {
              elems.push(getTSType(elem));
            } else {
              break;
            }
          };
          return onTypeNode.tuple(elems);
        }
        if (reference.target.isClassOrInterface()) {
          let typeArguments = reference.typeArguments?reference.typeArguments.map(getTSType):[];
          return onInterfaceReference(reference.target, typeArguments);
        }
      }
      if(memObjectType.isClassOrInterface()) {
        return onInterfaceReference(memObjectType, []);
      }
      // This __seems__ to work in case of Pick<..> and Record<..>
      if((memObjectType.objectFlags & ts.ObjectFlags.Mapped) &&
         (memObjectType.objectFlags & ts.ObjectFlags.Instantiated)) {

        let objDeclarations = memObjectType.symbol.getDeclarations();
        let props = memObjectType.getProperties().map((sym: ts.Symbol) =>
          property(sym, objDeclarations?objDeclarations[0]:sym.declarations?sym.declarations[1]:sym.valueDeclaration)
        )
        let fullyQualifiedName = checker.getFullyQualifiedName(memObjectType.symbol);
        return onTypeNode.anonymousObject({ properties: props, fullyQualifiedName });
      }
      if(memObjectType.objectFlags & ts.ObjectFlags.Anonymous) {
        // TODO: Currently any object which is "callable" is interpreted
        // as a plain function
        let signature = memObjectType.getCallSignatures()[0];
        if(signature) {
          log("Treating this as function: " + memObjectType.symbol.getName());
          let functionType = {
            parameters: signature.parameters.map((parameterSymbol) => {
              return {
                name: parameterSymbol.getName(),
                type: getTSType(checker.getTypeOfSymbolAtLocation(parameterSymbol, parameterSymbol?.valueDeclaration))
              };
            }),
            returnType: getTSType(signature.getReturnType())
          };
          log("Returning funciton type:" + functionType);
          return onTypeNode.function(functionType);
        }

        let props = memObjectType.getProperties().map((sym: ts.Symbol) => property(sym, sym.valueDeclaration));
        let fullyQualifiedName = checker.getFullyQualifiedName(memObjectType.symbol);
        return onTypeNode.anonymousObject({ fullyQualifiedName,  properties: props });
      }
      return onTypeNode.unknown("Uknown object type node (flags = " + memObjectType.objectFlags + "):" + checker.typeToString(memObjectType));
    }
    else if (memType.isTypeParameter()) {
      let d = memType.getDefault();
      return onTypeNode.typeParameter({ name: memType.symbol.escapedName, default: d?getTSType(d):null });
    }
    return onTypeNode.unknown(checker.typeToString(memType));
  }
}
// https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API#using-the-type-checker
function isNodeExported(checker:ts.TypeChecker, node: ts.Node): boolean {
  let sym = checker.getSymbolAtLocation(node);
    return (
      sym? ((ts.getCombinedModifierFlags(sym.valueDeclaration) & ts.ModifierFlags.Export) !== 0):false ||
      (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile && node.kind !== ts.SyntaxKind.EndOfFileToken)
    )
};

// https://stackoverflow.com/questions/53733138/how-do-i-type-check-a-snippet-of-typescript-code-in-memory
function createProgram(file: {path: string, source: Nullable<string>}, options: ts.CompilerOptions): ts.Program {
  const realHost = ts.createCompilerHost(options, true);
  let host = realHost;
  if(file.source) {
    let sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.ES5, true);
    host = {
      fileExists: filePath => filePath === file.path || realHost.fileExists(filePath),
      directoryExists: realHost.directoryExists && realHost.directoryExists.bind(realHost),
      getCurrentDirectory: realHost.getCurrentDirectory.bind(realHost),
      getDirectories: realHost.getDirectories?realHost.getDirectories.bind(realHost):undefined,
      getCanonicalFileName: fileName => realHost.getCanonicalFileName(fileName),
      getNewLine: realHost.getNewLine.bind(realHost),
      getDefaultLibFileName: realHost.getDefaultLibFileName.bind(realHost),
      getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === file.path
          ? sourceFile 
          : realHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile),
      readFile: filePath => filePath === file.path 
          ? file.source?file.source:undefined
          : realHost.readFile(filePath),
      useCaseSensitiveFileNames: () => realHost.useCaseSensitiveFileNames(),
      writeFile: (_, data) => { data },
    };
  } 
  return ts.createProgram([file.path], options, host);
}
