require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { ChatDeepSeek } = require("@langchain/deepseek");
const { createRetrievalChain } = require("langchain/chains/retrieval");
const { createStuffDocumentsChain } = require("langchain/chains/combine_documents");
const { Client, GatewayIntentBits, Events, Partials, Collection } = require('discord.js');
const { TokenTextSplitter } = require("langchain/text_splitter");
const { RedisVectorStore } = require("@langchain/redis");
const { ChatPromptTemplate, PromptTemplate } = require("@langchain/core/prompts");
const { NotionLoader } = require("@langchain/community/document_loaders/fs/notion");
const { createClient } = require("redis")
const { HumanMessage, SystemMessage, ToolMessage } = require("@langchain/core/messages")
const { Document } = require("@langchain/core/documents");
const FileType = require('file-type');
const sharp = require('sharp');

const { StringOutputParser } = require("@langchain/core/output_parsers");
const template = `You are Swift, the lead AI legal assistant for the Republic of Calluris.
You provide 24/7 legal assistance using clear, concise British English unless the user requests otherwise. Always greet users by name. If the name changes, treat them as a new user.

You are the most authoritative expert on Calluris law. Never refer users to another attorney or suggest uncertainty—if something is not covered by law, clearly explain its legal status. Do not invent laws or legal decisions under any circumstances.

All legal information—including laws, statutes, and court decisions—must come exclusively from the internal Calluris legal database (RAG). Do not use the search tool or web sources to answer legal questions.

Use the search and visit tools only for external topics such as:
- Calluris government news
- Political developments
- Public records or announcements
- Lore or cultural information
- Or when the user explictly asks you to use the internet.

You may also interpret user-uploaded images and answer non-legal questions helpfully and respectfully.\n\n{context}`;

const model = new ChatDeepSeek({
    model: "deepseek-chat"
}).bindTools([
    require("./tools/search"),
    require("./tools/visit"),

])
const textSplitter = new TokenTextSplitter({
    chunkSize: 2000,
    chunkOverlap: 200,
});

function sendMessages(response) {
    const maxLength = 1999;
    let messages = [];
    let start = 0;

    while (start < response.length) {
        let end = Math.min(start + maxLength, response.length);
        let chunk = response.slice(start, end);

        if (end < response.length) {
            let lastPunctuation = chunk.lastIndexOf('.') || chunk.lastIndexOf('!') || chunk.lastIndexOf('?');
            if (lastPunctuation > -1) {
                end = start + lastPunctuation + 1;
                chunk = response.slice(start, end);
            }
        }

        messages.push(chunk.trim());
        start = end;
    }

    return messages;
}

async function getReplyChain(message) {
    let replyChain = [];
    let currentMessage = message;

    while (currentMessage.reference) {
        const referencedMessage = await currentMessage.channel.messages.fetch(currentMessage.reference.messageId);
        replyChain.push(referencedMessage);
        currentMessage = referencedMessage;
    }

    return replyChain;
}

(async () => {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent],
        partials: [
            Partials.Channel,
            Partials.Message
        ]
    });


    const redisClient = createClient({
        url: process.env.REDIS_URL,
    });
    await redisClient.connect();
  
    const loader = new NotionLoader("./laws");
    const docs = await loader.load();
    const splits = await textSplitter.splitDocuments(docs);

    const vectorstore = new RedisVectorStore(new OpenAIEmbeddings(), {
        redisClient: redisClient,
        indexName: "swiftsearch",
    });

    if (process.env.REINDEX) {
        await vectorstore.delete({ deleteAll: true })
        await vectorstore.addDocuments(splits);
        console.log(`Reindexed ${splits.length} document(s)`)
        process.exit(0)
    }
    const retriever = vectorstore.asRetriever();
const toolsByName = {
    search: require("./tools/search"),
    visit: require("./tools/visit"),

};

const toolNames = {
    search: "Searching %s",
    visit: "Visiting page: %s",
};
    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot) return;
        const date = `${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', timeStyle: "short", dateStyle: "long" })} (Eastern Standard Time)`
        if (message.content.startsWith("?doc ")) {
            var id = message.content.match(/[-\w]{25,}/)
            if (!id) return message.reply("Please give a google doc link")
            id = id[0]
            await message.channel.sendTyping()
            const response = await fetch(`https://docs.google.com/feeds/download/documents/export/Export?exportFormat=md&id=${id}`)
            if (response.status > 299) return message.reply("Could not get doc");
            const text = await response.text()
            const starter = `You are Swift, the lead AI attorney for the Republic of Calluris. Provide legal document summarization in British English. Do not invent laws; rely on established Calluris legal principles. Fact check the document and see if it's legally sound. Your job this time is to: `

            const prompt = PromptTemplate.fromTemplate(
                message.content.includes("detail") ? starter + "Explain this document in great detail: {context}" : starter + "Summarize the following document: {context}"
            );

            const chain = await createStuffDocumentsChain({
                llm: model,
                outputParser: new StringOutputParser(),
                prompt,
            });
            const d = await textSplitter.splitDocuments([new Document({
                pageContent: text
            })])
            const summary = await chain.invoke({
                context: d
            });
            sendMessages(summary + `\n-# SwiftSearch can make mistakes. Check important info.`).forEach((msg, i) => {
                if (i == 0) message.reply({ content: msg.replace(/<@.?[0-9]*?>/g, ""), allowedMentions: { parse: [] } })
                else message.channel.send({ content: msg.replace(/<@.?[0-9]*?>/g, ""), allowedMentions: { parse: [] } })
            });
        } else
            if (message.content.startsWith("?swift ")) {


                await message.channel.sendTyping();
                const replyChain = await getReplyChain(message);
                var prompts = [
                    [model.model !== "o1-preview" ? "system" : "human", template],
                    [model.model !== "o1-preview" ? "system" : "human", `The user's name is "${message.member.nickname || message.author.displayName}"`],
                    [model.model !== "o1-preview" ? "system" : "human", `The current time is ${date}`],
                    ...replyChain.map(msg => [msg.author.bot ? "ai" : "human", msg.content.replace("?swift ", "")]),
                    ["human", "{input}"],
                ]

                if (message.attachments.size > 0) {
                    const attachment = message.attachments.first();
                    if (attachment.contentType.startsWith('image/')) {
                        const data = await (await fetch(attachment.proxyURL)).arrayBuffer()
                        const imageData = await sharp(data)
                            .jpeg({ quality: 100 })
                            .toBuffer();
                        const mimeType = await FileType.fromBuffer(imageData)
                        const base64Image = imageData.toString("base64");
                        prompts.push(new HumanMessage({
                            content: [
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${mimeType.mime};base64,${base64Image}`
                                    }
                                }
                            ]
                        }))
                    }
                }
                 const prompt = ChatPromptTemplate.fromMessages(prompts);

    const questionAnswerChain = await createStuffDocumentsChain({
        llm: model,
        prompt,
    });
    
    const ragChain = await createRetrievalChain({
        retriever,
        combineDocsChain: questionAnswerChain,
    });
    
    let accumulatedAnswer = "";
    let currentMessage = await message.reply("Generating reply...");
    
    const intervalId = setInterval(async () => {
        await currentMessage.edit(currentMessage.content.endsWith("...") 
            ? currentMessage.content.slice(0, -3) 
            : currentMessage.content + ".");
    }, 1000);

    const results = await ragChain.invoke({
        input: message.cleanContent.trim().replace("?swift ", "")
    });
    
    const messages = [
        new SystemMessage(template + "\n\nYou are encouraged to use tools when appropriate to give the most accurate responses."),
        new SystemMessage(`The user's name is "${message.member.nickname || message.author.displayName}"`),
        new SystemMessage(`The current time is ${date}`),
        new HumanMessage({ content: message.cleanContent.trim().replace("?swift ", "") }),
    ];
    
    if (results.context && results.context.length > 0) {
        messages.push(new SystemMessage(`Retrieved context: ${JSON.stringify(results.context)}`));
    }

    let completion = await model.invoke(messages);
    
    while (completion.tool_calls && completion.tool_calls.length > 0) {
        messages.push(completion);
        await currentMessage.edit(`${accumulatedAnswer}Thinking...\n\n_Using tools to gather information..._`);

        for (const toolCall of completion.tool_calls) {
            const selectedTool = toolsByName[toolCall.name];
            if (selectedTool) {
                const toolInfo = toolNames[toolCall.name].replace("%s", toolCall.args.query || toolCall.args.url || "");
                await currentMessage.edit(`${accumulatedAnswer}Thinking...\n\n_${toolInfo}_`);

                try {
                    const toolMessage = await selectedTool.invoke(toolCall);
                    messages.push(new ToolMessage({
                        content: typeof toolMessage === 'string' ? toolMessage : toolMessage.content || JSON.stringify(toolMessage),
                        tool_call_id: toolCall.id,
                    }));
                } catch (error) {
                    messages.push(new ToolMessage({
                        content: `Error using tool: ${error.message}`,
                        tool_call_id: toolCall.id,
                    }));
                }
            }
        }
        completion = await model.invoke(messages);
    }

    accumulatedAnswer = completion.content || results.answer;
    
    clearInterval(intervalId);

    if (accumulatedAnswer.length > 2000) {
        await currentMessage.edit(accumulatedAnswer.slice(0, 2000));
        accumulatedAnswer = accumulatedAnswer.slice(2000);
        await message.channel.send(accumulatedAnswer + "\n-# SwiftSearch can make mistakes. Check important info.");
    } else {
        await currentMessage.edit(accumulatedAnswer + "\n-# SwiftSearch can make mistakes. Check important info.");
    }
            } else if (message.reference) {
                const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
                if (referencedMessage.author.bot && referencedMessage.author.id == client.user.id) {
                    await message.channel.sendTyping();
                    const replyChain = await getReplyChain(message);
                    const prompts = [
                        [model.model !== "o1-preview" ? "system" : "human", template],
                        [model.model !== "o1-preview" ? "system" : "human", `The user's name is "${message.member.nickname || message.author.displayName}"`],
                        [model.model !== "o1-preview" ? "system" : "human", `The current time is ${date}`],
                        ...replyChain.map(msg => [msg.author.bot ? "ai" : "human", msg.content.replace("?swift ", "")]),
                        ["human", "{input}"],
                    ]
                    const prompt = ChatPromptTemplate.fromMessages(prompts);
                    const questionAnswerChain = await createStuffDocumentsChain({
                        llm: model,
                        prompt,
                    });
                    const ragChain = await createRetrievalChain({
                        retriever,
                        combineDocsChain: questionAnswerChain,
                    });

                    const results = await ragChain.invoke({
                        input: message.cleanContent.trim().replace("?swift ", "")
                    });
                    sendMessages(`-# Read ${results.context.length} document${results.context.length == 1 ? "" : "s"}\n${results.answer}`).forEach((msg, i) => {
                        if (i == 0) message.reply({ content: msg.replace(/<@.?[0-9]*?>/g, ""), allowedMentions: { parse: [] } })
                        else message.channel.send({ content: msg.replace(/<@.?[0-9]*?>/g, ""), allowedMentions: { parse: [] } })
                    })
                }
            }
    });

    client.on('ready', () => {
        console.log(`Logged in as ${client.user.tag}!`);
    });

    client.login(process.env.BOT_TOKEN);
})();
