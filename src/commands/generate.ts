import SwaggerParser from '@apidevtools/swagger-parser';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import ts from 'typescript';

const factory = ts.factory;

export function description() {
  return 'Generate a new sdk';
}

export function usage() {
  return '--input <path> --output <path> --base-url <url>|<variable>';
}

type Options = {
  input: string;
  output: string;
  baseUrl: string;
};

function isValidURL(str: string) {
  try {
    new URL(str);
    return true;
  } catch (_) {
    return false;
  }
}

function methodHasBody(method: string) {
  return ['POST', 'PUT', 'PATCH'].includes(method);
}

function getOptions(args: string[]): Options {
  if (args.length % 2 !== 0) {
    throw new Error('Invalid number of arguments');
  }

  const parsedArgs: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    // @ts-ignore
    parsedArgs[args[i]] = args[i + 1];
  }

  const options = {
    input: parsedArgs['--input'],
    output: parsedArgs['--output'],
    baseUrl: parsedArgs['--base-url'],
  };

  return options;
}

function extractParams(path: string): string[] {
  // This regular expression matches all occurrences of {param}
  const paramRegex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  const params: string[] = [];

  // Iterate over all matches of the regex in the path string
  while ((match = paramRegex.exec(path)) !== null) {
    // match[1] contains the captured group, which is the parameter name
    params.push(match[1]);
  }

  return params;
}

function isJSONResponse(response: unknown): response is {
  content: { 'application/json': { schema: Record<string, unknown> } };
} {
  return (
    typeof response === 'object' &&
    response !== null &&
    'content' in response &&
    typeof response['content'] === 'object' &&
    response['content'] !== null &&
    'application/json' in response['content'] &&
    typeof response['content']['application/json'] === 'object' &&
    response['content']['application/json'] !== null &&
    'schema' in response['content']['application/json'] &&
    typeof response['content']['application/json']['schema'] === 'object' &&
    response['content']['application/json']['schema'] !== null
  );
}

function makeDynamicBaseUrl(value: string) {
  const factory = ts.factory;
  const parts = value.split('.').map((part) => factory.createIdentifier(part));

  if (parts.length === 1) {
    return parts[0];
  }

  let expression = factory.createPropertyAccessExpression(parts[0], parts[1]);

  for (let i = 2; i < parts.length; i++) {
    expression = factory.createPropertyAccessExpression(expression, parts[i]);
  }

  return expression;
}

function makeTypeFromSchema(
  schema: unknown
):
  | ts.TypeLiteralNode
  | ts.KeywordTypeNode
  | ts.ArrayTypeNode
  | ts.TypeReferenceNode {
  if (typeof schema === 'object' && schema !== null) {
    if (
      'properties' in schema &&
      typeof schema.properties === 'object' &&
      schema.properties !== null
    ) {
      const properties = schema.properties;
      return factory.createTypeLiteralNode(
        Object.getOwnPropertyNames(properties).map((propertyName) => {
          const questionToken =
            'required' in schema &&
            Array.isArray(schema.required) &&
            schema.required?.includes(propertyName)
              ? undefined
              : factory.createToken(ts.SyntaxKind.QuestionToken);
          return factory.createPropertySignature(
            undefined,
            factory.createIdentifier(propertyName),
            questionToken,
            makeTypeFromSchema(
              properties[propertyName as keyof typeof properties]
            )
          );
        })
      );
    } else if ('type' in schema) {
      if (schema.type === 'object') {
        return factory.createTypeReferenceNode(
          factory.createIdentifier('Record'),
          [
            factory.createUnionTypeNode([
              factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
              factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            ]),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ]
        );
      } else if (schema.type === 'array') {
        if (
          'items' in schema &&
          typeof schema.items === 'object' &&
          schema.items !== null
        ) {
          return factory.createArrayTypeNode(makeTypeFromSchema(schema.items));
        } else {
          return factory.createArrayTypeNode(
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
          );
        }
      } else if (schema.type === 'integer' || schema.type === 'number') {
        return factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      } else if (schema.type === 'string') {
        return factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
      } else if (schema.type === 'boolean') {
        return factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
      }
    } else if ('allOf' in schema && Array.isArray(schema.allOf)) {
      return makeTypeFromSchema(
        Object.fromEntries(
          schema.allOf.map((schema) => Object.entries(schema)).flat()
        )
      );
    }
  }

  console.warn('Unknown schema', schema, 'using unknown as safe fallback');

  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

function makeOperationFunctionReturnType(responses: Record<string, unknown>) {
  const jsonResponses = Object.values(responses).filter(isJSONResponse);
  return factory.createTypeReferenceNode(factory.createIdentifier('Promise'), [
    factory.createTypeReferenceNode(factory.createIdentifier('TypedResponse'), [
      factory.createUnionTypeNode(
        jsonResponses.map((response) =>
          makeTypeFromSchema(response.content['application/json'].schema)
        )
      ),
    ]),
  ]);
}

function makeTemplateExpressionFromPath(path: string) {
  const factory = ts.factory;

  // Extract parameters from the path
  const params = extractParams(path); // Using the previously discussed extractParams function
  const pathSegments = path.split(/\{[^}]+\}/);

  if (params.length === 0) {
    // If there are no parameters, return a simple string
    return factory.createStringLiteral(path);
  }

  // Create the initial template head
  const templateHead = factory.createTemplateHead(
    pathSegments[0],
    pathSegments[0]
  );
  const spans: ts.TemplateSpan[] = [];

  // Iterate over parameters to create template spans
  params.forEach((param, index) => {
    const isLast = index === params.length - 1;
    const literalText = pathSegments[index + 1];
    const literal = isLast
      ? factory.createTemplateTail(literalText, literalText)
      : factory.createTemplateMiddle(literalText, literalText);

    const span = factory.createTemplateSpan(
      factory.createPropertyAccessExpression(
        factory.createIdentifier('params'),
        factory.createIdentifier(param)
      ),
      literal
    );

    spans.push(span);
  });

  // Combine the head and spans into a template expression
  return factory.createTemplateExpression(templateHead, spans);
}

function makeOperationFunction(config: {
  operationId: string;
  path: string;
  method: string;
  baseUrl: string;
  summary?: string;
  description?: string;
  responses: Record<string, unknown>;
}) {
  // console.dir(config, { depth: null });
  const params = extractParams(config.path);
  return factory.createFunctionDeclaration(
    [factory.createToken(ts.SyntaxKind.ExportKeyword)],
    undefined,
    factory.createIdentifier(config.operationId),
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createObjectBindingPattern(
          params.length
            ? [
                factory.createBindingElement(
                  undefined,
                  undefined,
                  factory.createIdentifier('search'),
                  undefined
                ),
                factory.createBindingElement(
                  undefined,
                  undefined,
                  factory.createIdentifier('params'),
                  undefined
                ),
              ]
            : [
                factory.createBindingElement(
                  undefined,
                  undefined,
                  factory.createIdentifier('search'),
                  undefined
                ),
              ]
        ),
        undefined,
        factory.createTypeLiteralNode(
          params.length
            ? [
                factory.createPropertySignature(
                  undefined,
                  factory.createIdentifier('search'),
                  factory.createToken(ts.SyntaxKind.QuestionToken),
                  factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)
                ),
                factory.createPropertySignature(
                  undefined,
                  factory.createIdentifier('params'),
                  undefined,
                  factory.createTypeReferenceNode(
                    factory.createIdentifier('Record'),
                    [
                      factory.createUnionTypeNode(
                        params.map((param) =>
                          factory.createLiteralTypeNode(
                            factory.createStringLiteral(param)
                          )
                        )
                      ),
                      factory.createKeywordTypeNode(
                        ts.SyntaxKind.StringKeyword
                      ),
                    ]
                  )
                ),
              ]
            : [
                factory.createPropertySignature(
                  undefined,
                  factory.createIdentifier('search'),
                  factory.createToken(ts.SyntaxKind.QuestionToken),
                  factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)
                ),
              ]
        ),
        undefined
      ),
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier('requestInit'),
        undefined,
        factory.createTypeReferenceNode(factory.createIdentifier('Omit'), [
          factory.createTypeReferenceNode(
            factory.createIdentifier('RequestInit'),
            undefined
          ),
          factory.createLiteralTypeNode(factory.createStringLiteral('method')),
        ]),
        undefined
      ),
    ],
    makeOperationFunctionReturnType(config.responses),
    factory.createBlock(
      [
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                factory.createIdentifier('url'),
                undefined,
                undefined,
                factory.createNewExpression(
                  factory.createIdentifier('URL'),
                  undefined,
                  [
                    makeTemplateExpressionFromPath(config.path),
                    config.baseUrl
                      ? isValidURL(config.baseUrl)
                        ? factory.createStringLiteral(config.baseUrl)
                        : makeDynamicBaseUrl(config.baseUrl)
                      : factory.createIdentifier('undefined'),
                  ]
                )
              ),
            ],
            ts.NodeFlags.Const
          )
        ),
        factory.createIfStatement(
          factory.createIdentifier('search'),
          factory.createBlock(
            [
              factory.createExpressionStatement(
                factory.createBinaryExpression(
                  factory.createPropertyAccessExpression(
                    factory.createIdentifier('url'),
                    factory.createIdentifier('search')
                  ),
                  factory.createToken(ts.SyntaxKind.EqualsToken),
                  factory.createIdentifier('search')
                )
              ),
            ],
            true
          ),
          undefined
        ),
        factory.createReturnStatement(
          factory.createCallExpression(
            factory.createIdentifier('fetch'),
            undefined,
            [
              factory.createIdentifier('url'),
              factory.createObjectLiteralExpression(
                [
                  factory.createPropertyAssignment(
                    factory.createIdentifier('method'),
                    factory.createStringLiteral(config.method)
                  ),
                  factory.createPropertyAssignment(
                    factory.createIdentifier('headers'),
                    factory.createCallExpression(
                      factory.createIdentifier('combineHeaders'),
                      undefined,
                      [
                        factory.createObjectLiteralExpression(
                          methodHasBody(config.method)
                            ? [
                                factory.createPropertyAssignment(
                                  factory.createStringLiteral('Accept'),
                                  factory.createStringLiteral(
                                    'application/json'
                                  )
                                ),
                                factory.createPropertyAssignment(
                                  factory.createStringLiteral('Content-Type'),
                                  factory.createStringLiteral(
                                    'application/json'
                                  )
                                ),
                              ]
                            : [
                                factory.createPropertyAssignment(
                                  factory.createStringLiteral('Accept'),
                                  factory.createStringLiteral(
                                    'application/json'
                                  )
                                ),
                              ],
                          false
                        ),
                        factory.createPropertyAccessExpression(
                          factory.createIdentifier('requestInit'),
                          factory.createIdentifier('headers')
                        ),
                      ]
                    )
                  ),
                  factory.createSpreadAssignment(
                    factory.createIdentifier('requestInit')
                  ),
                ],
                true
              ),
            ]
          )
        ),
      ],
      true
    )
  );
}

function makeTypedResponseType() {
  return factory.createTypeAliasDeclaration(
    undefined,
    factory.createIdentifier('TypedResponse'),
    [
      factory.createTypeParameterDeclaration(
        undefined,
        factory.createIdentifier('T'),
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
      ),
    ],
    factory.createIntersectionTypeNode([
      factory.createTypeReferenceNode(factory.createIdentifier('Omit'), [
        factory.createTypeReferenceNode(
          factory.createIdentifier('Response'),
          undefined
        ),
        factory.createLiteralTypeNode(factory.createStringLiteral('json')),
      ]),
      factory.createTypeLiteralNode([
        factory.createMethodSignature(
          undefined,
          factory.createIdentifier('json'),
          undefined,
          undefined,
          [],
          factory.createTypeReferenceNode(factory.createIdentifier('Promise'), [
            factory.createTypeReferenceNode(
              factory.createIdentifier('T'),
              undefined
            ),
          ])
        ),
      ]),
    ])
  );
}

function makeCombineHeadersFunction() {
  return ts.factory.createFunctionDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
    undefined,
    ts.factory.createIdentifier('combineHeaders'),
    undefined,
    [
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        ts.factory.createIdentifier('defaultHeaders'),
        undefined,
        ts.factory.createTypeReferenceNode(
          ts.factory.createIdentifier('HeadersInit'),
          undefined
        ),
        undefined
      ),
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        ts.factory.createIdentifier('headers'),
        ts.factory.createToken(ts.SyntaxKind.QuestionToken),
        ts.factory.createTypeReferenceNode(
          ts.factory.createIdentifier('HeadersInit'),
          undefined
        ),
        undefined
      ),
    ],
    ts.factory.createTypeReferenceNode(
      ts.factory.createIdentifier('Headers'),
      undefined
    ),
    ts.factory.createBlock(
      [
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                ts.factory.createIdentifier('combinedHeaders'),
                undefined,
                undefined,
                ts.factory.createNewExpression(
                  ts.factory.createIdentifier('Headers'),
                  undefined,
                  [ts.factory.createIdentifier('defaultHeaders')]
                )
              ),
            ],
            ts.NodeFlags.Const
          )
        ),
        ts.factory.createIfStatement(
          ts.factory.createIdentifier('headers'),
          ts.factory.createBlock(
            [
              ts.factory.createIfStatement(
                ts.factory.createBinaryExpression(
                  ts.factory.createIdentifier('headers'),
                  ts.factory.createToken(ts.SyntaxKind.InstanceOfKeyword),
                  ts.factory.createIdentifier('Headers')
                ),
                ts.factory.createBlock(
                  [
                    ts.factory.createExpressionStatement(
                      ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(
                          ts.factory.createIdentifier('headers'),
                          ts.factory.createIdentifier('forEach')
                        ),
                        undefined,
                        [
                          ts.factory.createArrowFunction(
                            undefined,
                            undefined,
                            [
                              ts.factory.createParameterDeclaration(
                                undefined,
                                undefined,
                                ts.factory.createIdentifier('value'),
                                undefined,
                                undefined,
                                undefined
                              ),
                              ts.factory.createParameterDeclaration(
                                undefined,
                                undefined,
                                ts.factory.createIdentifier('key'),
                                undefined,
                                undefined,
                                undefined
                              ),
                            ],
                            undefined,
                            ts.factory.createToken(
                              ts.SyntaxKind.EqualsGreaterThanToken
                            ),
                            ts.factory.createBlock(
                              [
                                ts.factory.createExpressionStatement(
                                  ts.factory.createCallExpression(
                                    ts.factory.createPropertyAccessExpression(
                                      ts.factory.createIdentifier(
                                        'combinedHeaders'
                                      ),
                                      ts.factory.createIdentifier('set')
                                    ),
                                    undefined,
                                    [
                                      ts.factory.createIdentifier('key'),
                                      ts.factory.createIdentifier('value'),
                                    ]
                                  )
                                ),
                              ],
                              true
                            )
                          ),
                        ]
                      )
                    ),
                  ],
                  true
                ),
                ts.factory.createIfStatement(
                  ts.factory.createCallExpression(
                    ts.factory.createPropertyAccessExpression(
                      ts.factory.createIdentifier('Array'),
                      ts.factory.createIdentifier('isArray')
                    ),
                    undefined,
                    [ts.factory.createIdentifier('headers')]
                  ),
                  ts.factory.createBlock(
                    [
                      ts.factory.createExpressionStatement(
                        ts.factory.createCallExpression(
                          ts.factory.createPropertyAccessExpression(
                            ts.factory.createIdentifier('headers'),
                            ts.factory.createIdentifier('forEach')
                          ),
                          undefined,
                          [
                            ts.factory.createArrowFunction(
                              undefined,
                              undefined,
                              [
                                ts.factory.createParameterDeclaration(
                                  undefined,
                                  undefined,
                                  ts.factory.createArrayBindingPattern([
                                    ts.factory.createBindingElement(
                                      undefined,
                                      undefined,
                                      ts.factory.createIdentifier('key'),
                                      undefined
                                    ),
                                    ts.factory.createBindingElement(
                                      undefined,
                                      undefined,
                                      ts.factory.createIdentifier('value'),
                                      undefined
                                    ),
                                  ]),
                                  undefined,
                                  undefined,
                                  undefined
                                ),
                              ],
                              undefined,
                              ts.factory.createToken(
                                ts.SyntaxKind.EqualsGreaterThanToken
                              ),
                              ts.factory.createBlock(
                                [
                                  ts.factory.createExpressionStatement(
                                    ts.factory.createCallExpression(
                                      ts.factory.createPropertyAccessExpression(
                                        ts.factory.createIdentifier(
                                          'combinedHeaders'
                                        ),
                                        ts.factory.createIdentifier('set')
                                      ),
                                      undefined,
                                      [
                                        ts.factory.createIdentifier('key'),
                                        ts.factory.createIdentifier('value'),
                                      ]
                                    )
                                  ),
                                ],
                                true
                              )
                            ),
                          ]
                        )
                      ),
                    ],
                    true
                  ),
                  ts.factory.createBlock(
                    [
                      ts.factory.createExpressionStatement(
                        ts.factory.createCallExpression(
                          ts.factory.createPropertyAccessExpression(
                            ts.factory.createCallExpression(
                              ts.factory.createPropertyAccessExpression(
                                ts.factory.createIdentifier('Object'),
                                ts.factory.createIdentifier('entries')
                              ),
                              undefined,
                              [ts.factory.createIdentifier('headers')]
                            ),
                            ts.factory.createIdentifier('forEach')
                          ),
                          undefined,
                          [
                            ts.factory.createArrowFunction(
                              undefined,
                              undefined,
                              [
                                ts.factory.createParameterDeclaration(
                                  undefined,
                                  undefined,
                                  ts.factory.createArrayBindingPattern([
                                    ts.factory.createBindingElement(
                                      undefined,
                                      undefined,
                                      ts.factory.createIdentifier('key'),
                                      undefined
                                    ),
                                    ts.factory.createBindingElement(
                                      undefined,
                                      undefined,
                                      ts.factory.createIdentifier('value'),
                                      undefined
                                    ),
                                  ]),
                                  undefined,
                                  undefined,
                                  undefined
                                ),
                              ],
                              undefined,
                              ts.factory.createToken(
                                ts.SyntaxKind.EqualsGreaterThanToken
                              ),
                              ts.factory.createBlock(
                                [
                                  ts.factory.createExpressionStatement(
                                    ts.factory.createCallExpression(
                                      ts.factory.createPropertyAccessExpression(
                                        ts.factory.createIdentifier(
                                          'combinedHeaders'
                                        ),
                                        ts.factory.createIdentifier('set')
                                      ),
                                      undefined,
                                      [
                                        ts.factory.createIdentifier('key'),
                                        ts.factory.createIdentifier('value'),
                                      ]
                                    )
                                  ),
                                ],
                                true
                              )
                            ),
                          ]
                        )
                      ),
                    ],
                    true
                  )
                )
              ),
            ],
            true
          ),
          undefined
        ),
        ts.factory.createReturnStatement(
          ts.factory.createIdentifier('combinedHeaders')
        ),
      ],
      true
    )
  );
}

export async function execute(args: string[]) {
  const options = getOptions(args);
  const inputPath = resolve(process.cwd(), options.input);
  const outputPath = resolve(process.cwd(), options.output);
  const inputDocument = await SwaggerParser.dereference(inputPath);

  const resultFile = ts.createSourceFile(
    'test.ts',
    '',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  if (!inputDocument.paths) {
    throw new Error('No paths');
  }

  const paths = inputDocument.paths;

  const operationConfigs = Object.getOwnPropertyNames(paths)
    .map((path) => {
      const pathItem = paths[path]!;
      return Object.keys(pathItem).map((method) => {
        const operation = pathItem[method as keyof typeof pathItem]!;
        if (Array.isArray(operation)) {
          throw new Error('Operation is an array');
        }
        if (typeof operation === 'string') {
          throw new Error('Operation is a string');
        }
        if (!('operationId' in operation)) {
          throw new Error('No operationId');
        }
        return {
          path,
          method: method.toUpperCase(),
          ...(operation as {
            operationId: string;
            description?: string;
            summary?: string;
            responses: Record<string, unknown>;
          }),
        };
      });
    })
    .flat();

  // @ts-ignore
  resultFile.statements = ts.factory.createNodeArray([
    makeTypedResponseType(),
    makeCombineHeadersFunction(),
    ...operationConfigs
      .map((config) => {
        const nodes: (ts.FunctionDeclaration | ts.JSDoc)[] = [];
        const jsDocNodes: string[] = [];
        if (config.summary) {
          jsDocNodes.push(`@summary ${config.summary}`);
        }
        if (config.description) {
          jsDocNodes.push(`@description ${config.description}`);
        }

        if (jsDocNodes.length) {
          nodes.push(ts.factory.createJSDocComment(jsDocNodes.join('\n')));
        }

        nodes.push(
          makeOperationFunction({
            baseUrl: options.baseUrl,
            ...config,
          })
        );
        return nodes;
      })
      .flat(),
  ]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  const result = printer.printFile(resultFile);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result);
}
