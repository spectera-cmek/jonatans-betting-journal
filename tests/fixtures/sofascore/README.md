# Sofascore-fixturer

Handgjorda efter Sofascores svarsformat (period → groups → statisticsItems,
lineups → home/away → players → player/statistics). Nyckelnamnen kontrollerades
mot riktiga svar med `npm run sofascore:capture` den 23 oktober 2026; hockey
använder `shots` och `secondsPlayed` per spelare och `Shots` per lag.

Riktiga, trimmade svar hamnar i `live/` när `npm run sofascore:capture` körs, och
testerna i `tests/sofascore.test.ts` kör mot dem också när de finns.
