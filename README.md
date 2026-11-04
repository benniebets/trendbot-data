# trendbot-data

Elke nacht (00:12 UTC) haalt GitHub Actions automatisch de slotkoersen op van Revolut X
(publieke API, geen sleutels) en wekelijks de handelsvolumes van CoinGecko.
De data staat in `data/` en voedt het paper-trading dashboard "Trendbot Zarattini".

Er worden hier nooit orders geplaatst: dit is alleen marktdata.
