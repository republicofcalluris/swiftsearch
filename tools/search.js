const { z } = require("zod")
const { tool } = require("@langchain/core/tools")
const search = require("../utils/search")
const schema = z.object({
    query: z
        .string()
        .describe("Query to search the web"),
});


const searchTool = tool(async function ({ query }) {
    console.log(`Searching for: ${query}`)
    return (await search(query))
},
    {
        name: "search",
        description: "Can search the internet for things.",
        schema: schema,
    });

module.exports = searchTool
