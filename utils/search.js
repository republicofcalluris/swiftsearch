const cheerio = require('cheerio');

module.exports = async function (search) {
   const html = await (await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(search)}`, {
        "credentials": "omit",
        "headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Sec-GPC": "1",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Priority": "u=0, i"
        },
        "method": "GET",
        "mode": "cors"
    })).text()

    const $ = cheerio.load(html);

    const results = [];

    $('table tr').each((i, row) => {
        const linkElement = $(row).find('a.result-link');
        const url = linkElement.attr('href') ? decodeURIComponent(linkElement.attr('href').replace("//duckduckgo.com/l/?uddg=", "")) : null;
        const title = linkElement.text();
        const snippet = $(row).find('td.result-snippet').text().trim()

        if (url && title) results.push(`Result ${i+1}:
Title: ${title}
URL: ${url}
Description: ${snippet}`);
    });

    return results.join("\n\n")
}
