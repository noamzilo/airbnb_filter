# Airbnb Archiver: problems it solves

Finding a long stay on Airbnb, minus the parts that make it painful.
Firefox, airbnb.com only, nothing leaves your browser.
*(Building it? See [DESIGN.md](DESIGN.md).)*

| Problem | Solution |
|---|---|
| The map, your saved places, the prices, your notes and the host chat are five different screens | All of it on one screen, next to the map |
| Airbnb keeps the host and the flat apart | Here they are one thing: the chat, the note and the price all hang off the flat |
| The same unsuitable places come back in every search | Bin one and it's gone for good |
| To see what you liked, you have to leave the map | Your list sits beside the map, your places are pins on it |
| Saved places vanish as you browse | Kept in your browser, so panning can't drop one |
| Which pin is this row? | Hover a row and its pin lights up |
| Airbnb shrinks the one you care about to an anonymous dot | Liked places keep the full price pill |
| Noting what the host just told you about the flat | Write the flat's note from the map screen or from the chat screen, same note |
| Can't remember which was which | A note on every place |
| Nightly rate, stay total, "monthly": hard to compare | Every price shown plainly: per 30 nights, per night, and the total |
| Everything's called "Apartment in Villa Morra" | The price is the headline; names on hover |
| Favourites in no order | Rank your own favorites |
| A heart is your only verdict | ★ Liked and ? Maybe |
| The price you saved is out of date | Re-checked live |

### Worth knowing

- **Firefox only.** The trick doesn't exist in Chrome.
- **No sync.** Lists live in the browser you made them in.
- **Private to you.** Not in the public add-on directory; updates arrive when one
  is built for you.
- **Follows Airbnb's site.** When they rebuild, this needs a nudge to keep up.
