#!/usr/bin/env bash
# Captures real, unauthenticated vendor API responses into tests/fixtures/vendor/ so the
# importer (src/parts) can be developed and tested against real data from a network that
# reaches the vendors. Run from server/:  bash scripts/capture-vendor-fixtures.sh
set -u
out="tests/fixtures/vendor"; mkdir -p "$out"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
log="$out/_status.txt"; : > "$log"
get() { # name url [curl args...]
  local name="$1" url="$2"; shift 2
  local code; code=$(curl -sS -L -m 40 -A "$UA" -o "$out/$name" -w '%{http_code} %{content_type} %{size_download}' "$@" "$url" 2>>"$log.err") || code="ERR $code"
  echo "$name | $code | $url" >> "$log"
}
for c in C25804 C14663 C8734 C2040 C6186 C165948 C82899 C7950 C2913202 C5446 C20917 C12084 C16581 C2765186 C393939; do
  get "easyeda_$c.json" "https://easyeda.com/api/products/$c/components?version=6.4.19.5"
done
for q in STM32F103C8T6 "10k 0603" AMS1117-3.3 "USB Type-C" ESP32-S3; do
  n=$(echo "$q" | tr ' ' '_')
  get "jlcsearch_list_$n.json" "https://jlcsearch.tscircuit.com/components/list.json?limit=20&full=true&search=$(echo "$q" | sed 's/ /%20/g')"
  get "jlcsearch_api_$n.json" "https://jlcsearch.tscircuit.com/api/search?limit=20&full=true&q=$(echo "$q" | sed 's/ /%20/g')"
  get "lcsc_search_$n.json" "https://wmsc.lcsc.com/ftps/wm/search/global?keyword=$(echo "$q" | sed 's/ /%20/g')"
  get "lcsc_search_v2_$n.json" "https://wmsc.lcsc.com/ftps/wm/search/v2/global" -H 'Content-Type: application/json' -H 'Origin: https://www.lcsc.com' -H 'Referer: https://www.lcsc.com/' --data "{\"keyword\":\"$q\",\"currentPage\":1,\"pageSize\":25}"
  get "jlcpcb_search_$n.json" "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList" -H 'Content-Type: application/json' -H 'Origin: https://jlcpcb.com' -H 'Referer: https://jlcpcb.com/parts' --data "{\"keyword\":\"$q\",\"currentPage\":1,\"pageSize\":25,\"searchSource\":\"search\",\"componentAttributes\":[]}"
  get "jlcpcb_search_v2_$n.json" "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2" -H 'Content-Type: application/json' -H 'Origin: https://jlcpcb.com' -H 'Referer: https://jlcpcb.com/parts' --data "{\"keyword\":\"$q\",\"currentPage\":1,\"pageSize\":25,\"searchSource\":\"search\",\"componentAttributes\":[]}"
  get "easyeda_search_$n.json" "https://easyeda.com/api/components/search" --data-urlencode "type=3" --data-urlencode "doctype[]=2" --data-urlencode "returnListStyle=classifyarr" --data-urlencode "wd=$q" --data-urlencode "version=6.5.42"
  get "easyedapro_search_$n.json" "https://pro.easyeda.com/api/v2/devices/search" --data-urlencode "wd=$q" --data-urlencode "page=1" --data-urlencode "pageSize=20" --data-urlencode "path=0819f05c4eef4c71ace90d822a990e87" --data-urlencode "uid=0819f05c4eef4c71ace90d822a990e87" --data-urlencode "returnListStyle=classifyarr"
done
get "lcsc_detail_C8734.json" "https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=C8734"
get "lcsc_detail_C25804.json" "https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=C25804"
get "jlcpcb_detail_C8734.json" "https://cart.jlcpcb.com/shoppingCart/smtGood/getComponentDetail?componentCode=C8734"
get "jlcpcb_detail2_C8734.json" "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/getComponentDetail?componentCode=C8734"
# 3D models: the footprint's SVGNODE names the model uuid
for c in C8734 C25804 C165948; do
  f="$out/easyeda_$c.json"; [ -s "$f" ] || continue
  u=$(grep -o 'SVGNODE~{[^}]*' "$f" | grep -o '\\"uuid\\":\\"[0-9a-f]*' | head -1 | grep -o '[0-9a-f]*$')
  [ -n "$u" ] || u=$(grep -o '"uuid":"[0-9a-f]\{32\}"' "$f" | head -1 | grep -o '[0-9a-f]\{32\}')
  echo "model uuid for $c: ${u:-none}" >> "$log"
  [ -n "$u" ] || continue
  get "model_${c}.obj" "https://modules.easyeda.com/3dmodel/$u"
  get "model_${c}.step" "https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/$u"
done
# What the keyed APIs answer without credentials (documents the error shape only)
get "mouser_nokey.json" "https://api.mouser.com/api/v1/search/keyword?apiKey=" -H 'Content-Type: application/json' --data '{"SearchByKeywordRequest":{"keyword":"STM32F103C8T6","records":5,"startingRecord":0}}'
get "digikey_nokey.json" "https://api.digikey.com/products/v4/search/keyword" -H 'Content-Type: application/json' --data '{"Keywords":"STM32F103C8T6","Limit":5}'
get "kicad_symbols_tree.json" "https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-symbols/repository/tree?per_page=100"
cat "$log"
