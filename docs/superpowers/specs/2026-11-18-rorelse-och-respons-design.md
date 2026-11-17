# Rörelse och respons (2026-11-18)

## Varför
Oddstavlan-designen (15 nov) var visuellt klar men kändes hård: inga övergångar alls,
allt slog om direkt, och rättningar gav ingen kvittens. Jonatan provade en testversion
i förhandsvisningen och valde att behålla den.

## Mål
- Appen svarar på det man gör: hovring, tryck, dialoger, sidbyten.
- Rättning och loggning ger en tydlig kvittens med möjlighet att ångra.

## Icke-mål / anti-mål
- Ingen ny visuell identitet; färger, typsnitt och rutnät är orörda.
- Inget som studsar, glöder eller rör sig av sig självt. Allt ≤ 240 ms, ease-out.
- Inget får synas för den som valt minskad rörelse (a11y.css nollar redan allt under `.ap`).

## Angreppssätt
- **A. Rörelse och respons** — valt. Störst skillnad i känsla för minst arbete, rör inte designen.
- B. Tydlighet och ordning (enheter, sortering, kompaktare mobilkort) — nästa steg, separat.
- C. Ny visuell riktning — avfärdat, designen är två dagar gammal.

## Vad som byggdes
- `app/styles/motion.css` (importeras sist före a11y.css): tokens `--ease-out`, `--dur-1..3`;
  färgövergångar på alla interaktiva ap-klasser; tryck = `scale(.96)`; overlay fade,
  modal/snabbsök pop-in, mobilarket glider upp; `.ap-main > *` och kort tonar fram vid mount
  (endast `backwards`-fill så ingen transform ligger kvar); KPI-remsan staggrad 30 ms/ruta;
  `.ap-openbet.is-leaving` glider ut och stänger luckan.
- `lib/toast.ts` + `components/Toaster.tsx`: en liten pub/sub-buss, `toast({title, detail, tone, action})`,
  max tre åt gången, paus vid hovring, ovanför bottenflikarna på mobil.
- Kvittenser: rättning (dialog + snabbrättning i Bets) med **Ångra** (DELETE på settle),
  ångrad rättning, loggat/uppdaterat/borttaget spel. Snabbrättningens `alert()` ersatt av en röd toast.

## Builderns egna val
- Varaktigheter och easing; vilka element som staggras; toastens placering och 4/6 s livslängd.
