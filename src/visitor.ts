import ts from "typescript";
import { VisitorContext } from "./types";
import { elideImportOrExportClause, resolvePathAndUpdateNode } from "./utils";

/* ****************************************************************************************************************** *
 * Helpers
 * ****************************************************************************************************************** */

const isAsyncImport = ({ tsInstance }: VisitorContext, node: ts.Node): node is ts.CallExpression =>
  tsInstance.isCallExpression(node) &&
  node.expression.kind === tsInstance.SyntaxKind.ImportKeyword &&
  tsInstance.isStringLiteral(node.arguments[0]) &&
  node.arguments.length === 1;

const isRequire = ({ tsInstance }: VisitorContext, node: ts.Node): node is ts.CallExpression =>
  tsInstance.isCallExpression(node) &&
  tsInstance.isIdentifier(node.expression) &&
  node.expression.text === "require" &&
  tsInstance.isStringLiteral(node.arguments[0]) &&
  node.arguments.length === 1;

/* ****************************************************************************************************************** *
 * Node Visitor
 * ****************************************************************************************************************** */

/**
 * Visit and replace nodes with module specifiers
 */
export function nodeVisitor(this: VisitorContext, node: ts.Node): ts.Node | undefined {
  const { factory, tsInstance, transformationContext } = this;

  /**
   * Update require / import functions
   *
   * require('module')
   * import('module')
   */
  if (isRequire(this, node) || isAsyncImport(this, node))
    return resolvePathAndUpdateNode(this, node, (<ts.StringLiteral>node.arguments[0]).text, (p) => {
      const res = factory.updateCallExpression(node, node.expression, node.typeArguments, [p]);

      /* Handle comments */
      const textNode = node.arguments[0];
      const commentRanges = tsInstance.getLeadingCommentRanges(textNode.getFullText(), 0) || [];

      for (const range of commentRanges) {
        const { kind, pos, end, hasTrailingNewLine } = range;

        const caption = textNode
          .getFullText()
          .substring(pos, end)
          .replace(
            /* searchValue */ kind === tsInstance.SyntaxKind.MultiLineCommentTrivia
              ? // Comment range in a multi-line comment with more than one line erroneously
                // includes the node's text in the range. For that reason, we use the greedy
                // selector in capture group and dismiss anything after the final comment close tag
                /^\/\*(.+)\*\/.*/s
              : /^\/\/(.+)/s,
            /* replaceValue */ "$1"
          );
        tsInstance.addSyntheticLeadingComment(p, kind, caption, hasTrailingNewLine);
      }

      return res;
    });

  /**
   * Update ExternalModuleReference
   *
   * import foo = require("foo");
   */
  if (tsInstance.isExternalModuleReference(node) && tsInstance.isStringLiteral(node.expression))
    return resolvePathAndUpdateNode(this, node, node.expression.text, (p) =>
      factory.updateExternalModuleReference(node, p)
    );

  /**
   * Update ImportTypeNode
   *
   * typeof import("./bar");
   * import ("package").MyType;
   */
  if (tsInstance.isImportTypeNode(node)) {
    const argument = node.argument as ts.LiteralTypeNode;
    if (!tsInstance.isStringLiteral(argument.literal)) return node;

    const { text } = argument.literal;
    if (!text) return node;

    const res = resolvePathAndUpdateNode(this, node, text, (p) =>
      factory.updateImportTypeNode(
        node,
        factory.updateLiteralTypeNode(argument, p),
        node.assertions,
        node.qualifier,
        node.typeArguments,
        node.isTypeOf
      )
    );

    return tsInstance.visitEachChild(res, this.getVisitor(), transformationContext);
  }

  /**
   * Update ImportDeclaration
   *
   * import ... 'module';
   */
  if (tsInstance.isImportDeclaration(node) && node.moduleSpecifier && tsInstance.isStringLiteral(node.moduleSpecifier))
    return resolvePathAndUpdateNode(this, node, node.moduleSpecifier.text, (p) => {
      let importClause = node.importClause;

      if (!this.isDeclarationFile && importClause?.namedBindings) {
        const updatedImportClause = elideImportOrExportClause(this, node);
        if (!updatedImportClause) return undefined; // No imports left, elide entire declaration
        importClause = updatedImportClause;
      }

      return factory.updateImportDeclaration(node, node.modifiers, importClause, p, node.assertClause);
    });

  /**
   * Update ExportDeclaration
   *
   * export ... 'module';
   */
  if (tsInstance.isExportDeclaration(node) && node.moduleSpecifier && tsInstance.isStringLiteral(node.moduleSpecifier))
    return resolvePathAndUpdateNode(this, node, node.moduleSpecifier.text, (p) => {
      let exportClause = node.exportClause;

      if (!this.isDeclarationFile && exportClause && tsInstance.isNamedExports(exportClause)) {
        const updatedExportClause = elideImportOrExportClause(this, node);
        if (!updatedExportClause) return undefined; // No export left, elide entire declaration
        exportClause = updatedExportClause;
      }

      return factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, exportClause, p, node.assertClause);
    });

  /**
   * Update module augmentation
   */
  if (tsInstance.isModuleDeclaration(node) && tsInstance.isStringLiteral(node.name))
    return resolvePathAndUpdateNode(this, node, node.name.text, (p) =>
      factory.updateModuleDeclaration(node, node.modifiers, p, node.body)
    );

  return tsInstance.visitEachChild(node, this.getVisitor(), transformationContext);
}
