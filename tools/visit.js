const { z } = require("zod")
const { tool } = require("@langchain/core/tools")
var { Readability } = require('@mozilla/readability');
var { JSDOM } = require('jsdom');
const schema = z.object({
    url: z
        .string()
        .describe("The URL you want to browse. Use this to get more info after a search."),
});


const visitTool = tool(async function ({ url }) {
    const html = await (await fetch(url)).text()
    var doc = new JSDOM(html, {
        url
    });
    console.log(`Accessing URL: ${url}`)
    let reader = new Readability(doc.window.document);
    const article = reader.parse();
    
    if (!article) {
        return "Could not extract content from the webpage.";
    }
    
    return article.textContent;
},
    {
        name: "visit",
        description: "Can load a URL and get the content of the page. Use this to get more info after a search.",
        schema,
    });

module.exports = visitTool
