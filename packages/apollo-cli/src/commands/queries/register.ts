import { Command, flags } from "@oclif/command";
import * as Listr from "listr";
import { print } from "graphql";
import * as crypto from "crypto";
import * as fs from "fs";
import { toPromise, execute } from "apollo-link";
import gql from "graphql-tag";
import { GraphQLError } from "graphql";

import { loadQueryDocuments } from "apollo-codegen-core/lib/loading";

import { engineFlags } from "../../engine-cli";
import { engineLink } from "../../engine";
import { resolveDocumentSets } from "../../config";
import { loadConfigStep } from "../../load-config";

export const REGISTER_QUERIES = gql`
  mutation RegisterQueries($hashes: [String!]!) {
    hash: String
  }
`;

export default class RegisterQueries extends Command {
  static description = "Extracts queries";

  static flags = {
    help: flags.help({
      char: "h",
      description: "Show command help"
    }),
    config: flags.string({
      description: "Path to your Apollo config file"
    }),
    queries: flags.string({
      description:
        "Path to your GraphQL queries, can include search tokens like **"
    }),
    json: flags.boolean({
      description: "Output result as JSON"
    }),
    ...engineFlags,

    tagName: flags.string({
      description:
        "Name of the template literal tag used to identify template literals containing GraphQL queries in Javascript/Typescript code",
      default: "gql"
    })
  };

  async run() {
    const { flags } = this.parse(RegisterQueries);

    const tasks: Listr = new Listr([
      loadConfigStep(flags, false),
      {
        title: "Resolving GraphQL document sets",
        task: async (ctx, task) => {
          ctx.documentSets = await resolveDocumentSets(ctx.config, false);
          const operations = loadQueryDocuments(
            flags.queries || ctx.documentSets[0].documentPaths,
            flags.tagName
          );
          task.title = `Scanning for GraphQL queries (${
            operations.length
          } found)`;
          // XXX send along file information as well
          ctx.operations = operations.map(doc => ({ document: print(doc) }));
        }
      },
      {
        title: "Generating hashes",
        task: async ctx => {
          ctx.mapping = {};
          (ctx.operations as Array<{ document: string }>).forEach(
            ({ document }) => {
              ctx.mapping[
                crypto
                  .createHash("sha512")
                  .update(document)
                  .digest("hex")
              ] = document;
            }
          );
        }
      },
      {
        title: "Outputing manifest",
        task: async ctx => {
          fs.writeFileSync("manifest.json", JSON.stringify(ctx.mapping));
        }
      },
      {
        title: "",
        task: async ctx => {
          const hashes = Object.keys(ctx.mapping);
          const variables = {
            hashes
          };

          console.log("Uploading " + hashes.length + " hashes");

          ctx.current = await toPromise(
            execute(engineLink, {
              query: REGISTER_QUERIES,
              variables,
              context: {
                headers: { ["x-api-key"]: process.env.ENGINE_API_KEY }
              }
            })
          )
            .then(async ({ data, errors }) => {
              // XXX better end user error message
              if (errors) {
                console.log("Query Registration failed with: ");
                console.log("\n");
                console.log(errors);
                throw new Error(
                  errors.map(({ message }) => message).join("\n")
                );
              }
              return data!.map;
            })
            .catch(e => {
              if (e.result && e.result.errors) {
                this.error(
                  e.result.errors
                    .map(({ message }: GraphQLError) => message)
                    .join("\n")
                );
              } else {
                this.error(e.message);
              }
            });
        }
      }
    ]);

    return tasks.run();
  }
}
