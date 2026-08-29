import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.38-deno-v1.30.0/deno-dom-wasm.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { feedUrl } = await req.json()
    if (!feedUrl) {
      return new Response(JSON.stringify({ error: 'feedUrl parameter is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const feedResponse = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 IndyBooksPWA/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    })

    if (!feedResponse.ok) {
      throw new Error(`Failed to fetch RSS feed URL. Status: ${feedResponse.status}`)
    }

    const xmlText = await feedResponse.text()

    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlText, 'text/html')

    const channelTitle = doc.querySelector('channel > title')?.textContent || 'Podcast Feed'
    const items = doc.querySelectorAll('item')
    const parsedEpisodes = []

    items.forEach((item, index) => {
      if (index > 30) return // Limit to 30 recent episodes
      const title = item.querySelector('title')?.textContent || 'Episode'
      const enclosure = item.querySelector('enclosure')
      const enclosureUrl = enclosure ? enclosure.getAttribute('url') : ''
      const imageEl = item.querySelector('image') || doc.querySelector('channel > image > url')
      const image = imageEl ? imageEl.textContent || imageEl.getAttribute('href') : ''

      if (enclosureUrl) {
        parsedEpisodes.push({
          title: title.trim(),
          enclosureUrl: enclosureUrl.trim(),
          image: image ? image.trim() : ''
        })
      }
    })

    return new Response(
      JSON.stringify({
        title: channelTitle.trim(),
        items: parsedEpisodes
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Internal error parsing RSS feed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})