import Medusa from "@medusajs/js-sdk";
import { config } from "dotenv";
import { z, ZodTypeAny } from "zod";
import storeJson from "../oas/store.json";
import { SdkRequestType, StoreJson, Parameter } from "../types/store-json";
import { defineTool, InferToolHandlerInput } from "../utils/define-tools";
import { StoreProductListResponse } from "@medusajs/types";

config();

const MEDUSA_BACKEND_URL =
    process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000";

export default class MedusaStoreService {
    sdk: Medusa;
    constructor(
        medusaBackendUrl: string = MEDUSA_BACKEND_URL,
        apiKey: string = process.env.PUBLISHABLE_KEY ?? ""
    ) {
        this.sdk = new Medusa({
            baseUrl: medusaBackendUrl ?? MEDUSA_BACKEND_URL,
            debug: process.env.NODE_ENV === "development",
            publishableKey: apiKey ?? process.env.PUBLISHABLE_KEY,
            auth: {
                type: "session"
            }
        });
    }

    // Helper to resolve $ref in schemas
    resolveSchemaRef(schema: any, storeJsonObj: any): any {
        if (!schema) return null;

        // If schema has $ref, resolve it
        if (schema.$ref) {
            const refPath = schema.$ref.replace('#/components/schemas/', '');
            const resolvedSchema = storeJsonObj.components?.schemas?.[refPath];
            return resolvedSchema || null;
        }

        return schema;
    }

    wrapPath(refPath: string, refFunction: SdkRequestType) {
        return defineTool((z): any => {
            let name;
            let description;
            let parameters: Parameter[] = [];
            let method = "get";
            let requestBodySchema: any = null;

            if ("get" in refFunction) {
                method = "get";
                name = refFunction.get.operationId;
                description = refFunction.get.description;
                parameters = refFunction.get.parameters;
            } else if ("post" in refFunction) {
                method = "post";
                name = refFunction.post.operationId;
                description = refFunction.post.description;
                parameters = refFunction.post.parameters ?? [];
                // Extract request body schema
                const postMethod = refFunction.post as any;
                if (postMethod.requestBody?.content?.["application/json"]?.schema) {
                    let schema = postMethod.requestBody.content["application/json"].schema;
                    // Resolve $ref if present
                    requestBodySchema = this.resolveSchemaRef(schema, storeJson);
                }
            }
            if (!name) {
                throw new Error("No name found for the function");
            }

            // Helper function to convert JSON schema properties to Zod schemas (recursive)
            const convertSchemaPropertyToZod = (prop: any, makeOptional: boolean = true): any => {
                if (!prop) return makeOptional ? z.any().optional() : z.any();

                // Handle $ref at the property level
                let resolvedProp = prop;
                if (prop.$ref) {
                    resolvedProp = this.resolveSchemaRef(prop, storeJson);
                    if (!resolvedProp) return makeOptional ? z.any().optional() : z.any();
                }

                let zodSchema: any;

                switch (resolvedProp.type) {
                    case "string":
                        zodSchema = z.string();
                        break;
                    case "number":
                    case "integer":
                        zodSchema = z.number();
                        break;
                    case "boolean":
                        zodSchema = z.boolean();
                        break;
                    case "array":
                        // Handle array items - resolve $ref if present
                        if (resolvedProp.items) {
                            let itemSchema = resolvedProp.items;
                            if (itemSchema.$ref) {
                                itemSchema = this.resolveSchemaRef(itemSchema, storeJson);
                            }
                            // Recursively convert item schema to Zod (items are not optional by default)
                            if (itemSchema) {
                                const itemZodSchema = convertSchemaPropertyToZod(itemSchema, false);
                                zodSchema = z.array(itemZodSchema);
                            } else {
                                zodSchema = z.array(z.any());
                            }
                        } else {
                            zodSchema = z.array(z.any());
                        }
                        break;
                    case "object":
                        // Handle nested object properties
                        if (resolvedProp.properties) {
                            const nestedSchema = Object.entries(resolvedProp.properties).reduce((acc, [key, value]) => {
                                // Nested object properties can be optional based on the schema's required array
                                const isRequired = resolvedProp.required?.includes(key);
                                acc[key] = convertSchemaPropertyToZod(value, !isRequired);
                                return acc;
                            }, {} as any);
                            zodSchema = z.object(nestedSchema);
                        } else {
                            zodSchema = z.object({});
                        }
                        break;
                    default:
                        zodSchema = z.any();
                }

                return makeOptional ? zodSchema.optional() : zodSchema;
            };

            // Build input schema from parameters
            const parameterSchema = parameters
                .filter((p) => p.in != "header")
                .reduce((acc, param) => {
                    acc[param.name] = convertSchemaPropertyToZod(param.schema);
                    return acc;
                }, {} as any);

            // Build input schema from request body
            let bodySchema = {};
            if (requestBodySchema?.properties) {
                bodySchema = Object.entries(requestBodySchema.properties).reduce((acc, [key, value]) => {
                    acc[key] = convertSchemaPropertyToZod(value);
                    return acc;
                }, {} as any);
            }

            return {
                name: name!,
                description: description,
                inputSchema: {
                    ...parameterSchema,
                    ...bodySchema
                },

                handler: async (
                    input: InferToolHandlerInput<any, ZodTypeAny>
                ): Promise<any> => {
                    // Separate path/query parameters from body parameters
                    const bodyPropertyNames = requestBodySchema?.properties
                        ? new Set(Object.keys(requestBodySchema.properties))
                        : new Set();

                    // Build query parameters (from parameters that are in path/query)
                    const queryParams: Record<string, any> = {};
                    const pathParams: Record<string, any> = {};
                    const bodyParams: Record<string, any> = {};

                    Object.entries(input).forEach(([key, value]) => {
                        const param = parameters.find(p => p.name === key);
                        if (param) {
                            if (param.in === "path") {
                                pathParams[key] = value;
                            } else if (param.in === "query") {
                                queryParams[key] = value;
                            }
                        } else if (bodyPropertyNames.has(key)) {
                            // This is a body parameter
                            bodyParams[key] = value;
                        }
                    });

                    // Replace path parameters in refPath
                    let finalPath = refPath;
                    Object.entries(pathParams).forEach(([key, value]) => {
                        finalPath = finalPath.replace(`{${key}}`, String(value));
                    });

                    const query = new URLSearchParams(queryParams as any);

                    if (method === "get") {
                        console.error(
                            `Fetching ${finalPath} with GET ${query.toString()}`
                        );
                        const response = await this.sdk.client.fetch(finalPath, {
                            method: method,
                            headers: {
                                "Content-Type": "application/json",
                                "Accept": "application/json",
                                "Authorization": `Bearer ${process.env.PUBLISHABLE_KEY}`
                            },
                            query: query
                        });
                        return response;
                    } else {
                        const response = await this.sdk.client.fetch(finalPath, {
                            method: method,
                            headers: {
                                "Content-Type": "application/json",
                                "Accept": "application/json",
                                "Authorization": `Bearer ${process.env.PUBLISHABLE_KEY}`
                            },
                            query,
                            body: bodyParams
                        });
                        return response;
                    }
                }
            };
        });
    }

    defineTools(store = storeJson): any[] {
        const paths = Object.entries(store.paths) as [string, SdkRequestType][];
        const tools = paths.map(([path, refFunction]) =>
            this.wrapPath(path, refFunction)
        );
        return tools;
    }
}
