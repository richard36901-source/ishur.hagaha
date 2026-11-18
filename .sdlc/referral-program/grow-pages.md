# referral-program · Grow pages for the 20% friend discount (Richard creates by hand)

30 permanent pages, one per package (10 sizes × 3 plans), priced at **80%** (whole ₪, `Math.round(full × 0.8)`).
Same settings as the existing package pages (auto-invoice on, success URL `https://ishur.io/thanks.html`, cancel URL `https://ishur.io/`).

**Why the name matters:** the Worker's IPN reads the page description. `"<N> מוזמנים <plan> · הנחת חבר"` still parses as
tier N / plan (tested: `parsePaidDesc('300 מוזמנים פרמיום · הנחת חבר')` → 300 / pro) and `looksIshur` matches on "מוזמנים".
Do not drop the word מוזמנים or the plan word.

**Custom field:** the site appends `?cField3=ref:<code>` to the page link. If Grow echoes `cField3` on the IPN the attribution is
direct; if it does not, the Worker still attributes through `refpend:<phone>` (the site records code↔phone before redirecting).

**Where the links go:** `config.js` → `GROW_LINKS_REF` → the matching key. An empty key is not an error: the popup mints a
server-priced 80% link through Make (scenario 7362541, cField3 mapped 12/11) until the page exists.

| key (config.js) | Page name | Page title | Product name | List | **Page price** |
|---|---|---|---|---|---|
| `50_basic` | 50 מוזמנים בסיס · הנחת חבר | 50 מוזמנים בסיס · הנחת חבר | 50 מוזמנים בסיס · הנחת חבר | ₪50 | **₪40** |
| `50_pro` | 50 מוזמנים פרמיום · הנחת חבר | 50 מוזמנים פרמיום · הנחת חבר | 50 מוזמנים פרמיום · הנחת חבר | ₪95 | **₪76** |
| `50_premium` | 50 מוזמנים הכל כלול · הנחת חבר | 50 מוזמנים הכל כלול · הנחת חבר | 50 מוזמנים הכל כלול · הנחת חבר | ₪140 | **₪112** |
| `100_basic` | 100 מוזמנים בסיס · הנחת חבר | 100 מוזמנים בסיס · הנחת חבר | 100 מוזמנים בסיס · הנחת חבר | ₪99 | **₪79** |
| `100_pro` | 100 מוזמנים פרמיום · הנחת חבר | 100 מוזמנים פרמיום · הנחת חבר | 100 מוזמנים פרמיום · הנחת חבר | ₪149 | **₪119** |
| `100_premium` | 100 מוזמנים הכל כלול · הנחת חבר | 100 מוזמנים הכל כלול · הנחת חבר | 100 מוזמנים הכל כלול · הנחת חבר | ₪199 | **₪159** |
| `200_basic` | 200 מוזמנים בסיס · הנחת חבר | 200 מוזמנים בסיס · הנחת חבר | 200 מוזמנים בסיס · הנחת חבר | ₪199 | **₪159** |
| `200_pro` | 200 מוזמנים פרמיום · הנחת חבר | 200 מוזמנים פרמיום · הנחת חבר | 200 מוזמנים פרמיום · הנחת חבר | ₪279 | **₪223** |
| `200_premium` | 200 מוזמנים הכל כלול · הנחת חבר | 200 מוזמנים הכל כלול · הנחת חבר | 200 מוזמנים הכל כלול · הנחת חבר | ₪339 | **₪271** |
| `300_basic` | 300 מוזמנים בסיס · הנחת חבר | 300 מוזמנים בסיס · הנחת חבר | 300 מוזמנים בסיס · הנחת חבר | ₪299 | **₪239** |
| `300_pro` | 300 מוזמנים פרמיום · הנחת חבר | 300 מוזמנים פרמיום · הנחת חבר | 300 מוזמנים פרמיום · הנחת חבר | ₪379 | **₪303** |
| `300_premium` | 300 מוזמנים הכל כלול · הנחת חבר | 300 מוזמנים הכל כלול · הנחת חבר | 300 מוזמנים הכל כלול · הנחת חבר | ₪449 | **₪359** |
| `400_basic` | 400 מוזמנים בסיס · הנחת חבר | 400 מוזמנים בסיס · הנחת חבר | 400 מוזמנים בסיס · הנחת חבר | ₪399 | **₪319** |
| `400_pro` | 400 מוזמנים פרמיום · הנחת חבר | 400 מוזמנים פרמיום · הנחת חבר | 400 מוזמנים פרמיום · הנחת חבר | ₪489 | **₪391** |
| `400_premium` | 400 מוזמנים הכל כלול · הנחת חבר | 400 מוזמנים הכל כלול · הנחת חבר | 400 מוזמנים הכל כלול · הנחת חבר | ₪559 | **₪447** |
| `500_basic` | 500 מוזמנים בסיס · הנחת חבר | 500 מוזמנים בסיס · הנחת חבר | 500 מוזמנים בסיס · הנחת חבר | ₪499 | **₪399** |
| `500_pro` | 500 מוזמנים פרמיום · הנחת חבר | 500 מוזמנים פרמיום · הנחת חבר | 500 מוזמנים פרמיום · הנחת חבר | ₪589 | **₪471** |
| `500_premium` | 500 מוזמנים הכל כלול · הנחת חבר | 500 מוזמנים הכל כלול · הנחת חבר | 500 מוזמנים הכל כלול · הנחת חבר | ₪669 | **₪535** |
| `600_basic` | 600 מוזמנים בסיס · הנחת חבר | 600 מוזמנים בסיס · הנחת חבר | 600 מוזמנים בסיס · הנחת חבר | ₪599 | **₪479** |
| `600_pro` | 600 מוזמנים פרמיום · הנחת חבר | 600 מוזמנים פרמיום · הנחת חבר | 600 מוזמנים פרמיום · הנחת חבר | ₪699 | **₪559** |
| `600_premium` | 600 מוזמנים הכל כלול · הנחת חבר | 600 מוזמנים הכל כלול · הנחת חבר | 600 מוזמנים הכל כלול · הנחת חבר | ₪789 | **₪631** |
| `700_basic` | 700 מוזמנים בסיס · הנחת חבר | 700 מוזמנים בסיס · הנחת חבר | 700 מוזמנים בסיס · הנחת חבר | ₪699 | **₪559** |
| `700_pro` | 700 מוזמנים פרמיום · הנחת חבר | 700 מוזמנים פרמיום · הנחת חבר | 700 מוזמנים פרמיום · הנחת חבר | ₪819 | **₪655** |
| `700_premium` | 700 מוזמנים הכל כלול · הנחת חבר | 700 מוזמנים הכל כלול · הנחת חבר | 700 מוזמנים הכל כלול · הנחת חבר | ₪919 | **₪735** |
| `800_basic` | 800 מוזמנים בסיס · הנחת חבר | 800 מוזמנים בסיס · הנחת חבר | 800 מוזמנים בסיס · הנחת חבר | ₪799 | **₪639** |
| `800_pro` | 800 מוזמנים פרמיום · הנחת חבר | 800 מוזמנים פרמיום · הנחת חבר | 800 מוזמנים פרמיום · הנחת חבר | ₪929 | **₪743** |
| `800_premium` | 800 מוזמנים הכל כלול · הנחת חבר | 800 מוזמנים הכל כלול · הנחת חבר | 800 מוזמנים הכל כלול · הנחת חבר | ₪1049 | **₪839** |
| `900_basic` | 900 מוזמנים בסיס · הנחת חבר | 900 מוזמנים בסיס · הנחת חבר | 900 מוזמנים בסיס · הנחת חבר | ₪899 | **₪719** |
| `900_pro` | 900 מוזמנים פרמיום · הנחת חבר | 900 מוזמנים פרמיום · הנחת חבר | 900 מוזמנים פרמיום · הנחת חבר | ₪1049 | **₪839** |
| `900_premium` | 900 מוזמנים הכל כלול · הנחת חבר | 900 מוזמנים הכל כלול · הנחת חבר | 900 מוזמנים הכל כלול · הנחת חבר | ₪1179 | **₪943** |

After pasting the 30 links: bump `config.js?v=` on index.html (the popup reads the map at load) and run
`node scripts/referral-ui-smoke.mjs` — it asserts the map has 30 keys and that every filled link is `https://pay.grow.link/…`.


## Created 12/11 via Make scenario 8538439 "ishur - referral 80% page (permanent)" (hook 4093331), pasted into config.js
| key | link |
|---|---|
| `50_basic` | https://pay.grow.link/NTY2OTg~74d13a95cd635406a34814241134a655-NDI4NjU5Mw |
| `50_pro` | https://pay.grow.link/NTY2OTg~4255133f8f619a26bc571bbdd398795e-NDI4NjU5OA |
| `50_premium` | https://pay.grow.link/NTY2OTg~82a4ffe408518d88aa6515723954251f-NDI4NjU5OQ |
| `100_basic` | https://pay.grow.link/NTY2OTg~8f3d836778ea6f4927f163055c1f9467-NDI4NjYwMQ |
| `100_pro` | https://pay.grow.link/NTY2OTg~e1c6fa118d99ba1f14edd1311dbe3b40-NDI4NjYwNA |
| `100_premium` | https://pay.grow.link/NTY2OTg~ed745ae9fcf410085a1095b74594fa52-NDI4NjYwNQ |
| `200_basic` | https://pay.grow.link/NTY2OTg~a6008dad411551714bd7e6c577f11604-NDI4NjYwNg |
| `200_pro` | https://pay.grow.link/NTY2OTg~8b932f3a2d584568ca095031b2af2ba2-NDI4NjYwNw |
| `200_premium` | https://pay.grow.link/NTY2OTg~0a632588bb77b22af2af78c17af111e6-NDI4NjYwOQ |
| `300_basic` | https://pay.grow.link/NTY2OTg~1757c4af27628dc5367791d8a73558dc-NDI4NjYxMA |
| `300_pro` | https://pay.grow.link/NTY2OTg~bfed288015cb647a79d2bc97f2daf33c-NDI4NjYxMQ |
| `300_premium` | https://pay.grow.link/NTY2OTg~9801a836f9f44a94a3f3e50c6a6e7bee-NDI4NjYxMg |
| `400_basic` | https://pay.grow.link/NTY2OTg~c8a4108d38a92d0945b98fffe072dc4b-NDI4NjYxMw |
| `400_pro` | https://pay.grow.link/NTY2OTg~190968f85114a90c873e6900a5b54b7c-NDI4NjYxNA |
| `400_premium` | https://pay.grow.link/NTY2OTg~e8616162a0036188d25f71787eeb7371-NDI4NjYxNg |
| `500_basic` | https://pay.grow.link/NTY2OTg~207ee631121ac123e50f8bd55e078828-NDI4NjYxOQ |
| `500_pro` | https://pay.grow.link/NTY2OTg~6408061e4a47b53d1f993adc9f2c76d7-NDI4NjYyMA |
| `500_premium` | https://pay.grow.link/NTY2OTg~e5bbdacf44a79065a55c3a93d3202b99-NDI4NjYyMQ |
| `600_basic` | https://pay.grow.link/NTY2OTg~5d491375c8562390bc073416bf23d8b8-NDI4NjYyMg |
| `600_pro` | https://pay.grow.link/NTY2OTg~5ab4019b1d48d2ca4d55b67de71fdec5-NDI4NjYyMw |
| `600_premium` | https://pay.grow.link/NTY2OTg~3973f892550c358c4d04cdaeaf934c5a-NDI4NjYyNQ |
| `700_basic` | https://pay.grow.link/NTY2OTg~993c747b5d4ff28b6e88a05b6b6a879a-NDI4NjYyNg |
| `700_pro` | https://pay.grow.link/NTY2OTg~4a5621b1a7273260d32f49fe78896959-NDI4NjYyNw |
| `700_premium` | https://pay.grow.link/NTY2OTg~c0dcb11d50123b224e5c28b27ff105a5-NDI4NjYyOQ |
| `800_basic` | https://pay.grow.link/NTY2OTg~b2a9a1796a562648440e1a75d7bb09a8-NDI4NjYzMA |
| `800_pro` | https://pay.grow.link/NTY2OTg~8e78ccc6d6bbf10f17c93defda56e070-NDI4NjYzMQ |
| `800_premium` | https://pay.grow.link/NTY2OTg~2ec6e9cb2a75e44e6fe77f9076fc8a9a-NDI4NjYzMg |
| `900_basic` | https://pay.grow.link/NTY2OTg~cdd743d42a3dfa3aaac057743fab92fd-NDI4NjYzMw |
| `900_pro` | https://pay.grow.link/NTY2OTg~b6f9f474cbf922de04f4825979645eb8-NDI4NjYzNg |
| `900_premium` | https://pay.grow.link/NTY2OTg~94b500c572cfbe8500e518a883151b3c-NDI4NjYzNw |
