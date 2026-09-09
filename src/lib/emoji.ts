/**
 * Bundled emoji set — no font download, no remote index.
 *
 * Entries are `glyph|keywords`, split at load. Keeping the source as compact
 * strings keeps the picker's data under a few kilobytes.
 */

export interface EmojiCategory {
  id: string;
  label: string;
  icon: string;
  items: { glyph: string; keywords: string }[];
}

const RAW: Array<[string, string, string, string]> = [
  [
    'smileys',
    'Smileys & people',
    '😀',
    '😀 grin smile happy|😃 smile happy joy|😄 smile laugh happy|😁 beam grin|😆 laugh satisfied|😅 sweat laugh relief|🤣 rofl laugh|😂 joy tears laugh|🙂 slight smile|🙃 upside down silly|😉 wink|😊 blush smile|😇 innocent halo angel|🥰 love hearts adore|😍 heart eyes love|🤩 star struck wow|😘 kiss blow|😗 kiss|😚 kiss closed|😙 kiss smile|😋 yum tasty|😛 tongue|😜 wink tongue joke|🤪 zany crazy silly|😝 squint tongue|🤑 money mouth rich|🤗 hug|🤭 hand over mouth oops|🤫 shush quiet|🤔 thinking hmm|🤐 zipper secret|🤨 raised eyebrow doubt|😐 neutral|😑 expressionless|😶 no mouth silence|😏 smirk|😒 unamused meh|🙄 eye roll|😬 grimace awkward|🤥 lying nose|😌 relieved calm|😔 pensive sad|😪 sleepy tired|🤤 drool|😴 sleeping zzz|😷 mask sick|🤒 thermometer sick|🤕 bandage hurt|🤢 nauseated sick|🤮 vomit sick|🤧 sneeze|🥵 hot heat|🥶 cold freezing|🥴 woozy dizzy|😵 dizzy knocked|🤯 mind blown explode|🤠 cowboy|🥳 party celebrate|😎 sunglasses cool|🤓 nerd glasses|🧐 monocle inspect|😕 confused|😟 worried|🙁 frown|☹️ frown sad|😮 open mouth wow|😯 hushed surprise|😲 astonished shock|😳 flushed embarrassed|🥺 pleading puppy|😦 frowning open|😧 anguished|😨 fearful scared|😰 anxious sweat|😥 sad relieved|😢 cry tear sad|😭 sob cry loud|😱 scream fear|😖 confounded|😣 persevere struggle|😞 disappointed|😓 downcast sweat|😩 weary tired|😫 tired exhausted|🥱 yawn bored|😤 triumph steam angry|😡 rage angry mad|😠 angry mad|🤬 cursing swear|😈 devil smiling|👿 imp angry devil|💀 skull dead|☠️ skull crossbones|💩 poop|🤡 clown|👹 ogre|👺 goblin|👻 ghost boo|👽 alien|👾 space invader game|🤖 robot bot|😺 cat grin|😸 cat smile|😹 cat joy|😻 cat heart eyes|😼 cat smirk|😽 cat kiss|🙀 cat weary|😿 cat cry|😾 cat pouting|🙈 see no evil monkey|🙉 hear no evil monkey|🙊 speak no evil monkey|👋 wave hello hi|🤚 raised back hand|🖐 hand fingers splayed|✋ raised hand stop|🖖 vulcan spock|👌 ok perfect|🤏 pinch small|✌️ victory peace|🤞 crossed fingers luck|🤟 love you|🤘 rock horns|🤙 call me shaka|👈 point left|👉 point right|👆 point up|👇 point down|☝️ point up index|👍 thumbs up yes like|👎 thumbs down no dislike|✊ fist raised|👊 fist bump punch|🤛 left fist|🤜 right fist|👏 clap applause|🙌 raised hands praise|👐 open hands|🤲 palms up|🤝 handshake deal|🙏 pray thanks please|✍️ writing hand|💅 nail polish|🤳 selfie|💪 muscle strong flex|🧠 brain|👀 eyes look|👁 eye|👶 baby|🧒 child|👦 boy|👧 girl|🧑 person|👨 man|👩 woman|🧓 older person|👴 old man|👵 old woman|🙍 frowning person|🙎 pouting person|🙅 no gesture|🙆 ok gesture|💁 tipping hand info|🙋 raising hand|🧏 deaf person|🙇 bowing sorry|🤦 facepalm|🤷 shrug idk|👮 police officer|🕵️ detective spy|💂 guard|👷 construction worker|🤴 prince|👸 princess|👳 turban|🧕 headscarf|🤵 tuxedo|👰 bride veil|🤰 pregnant|🍼 baby bottle|👨‍💻 technologist developer|👩‍💻 technologist developer|🧑‍🚀 astronaut|🧙 mage wizard|🧚 fairy|🧛 vampire|🧜 merperson|🧝 elf|🧞 genie|🧟 zombie|💆 massage|💇 haircut|🚶 walking|🏃 running run|💃 dancing woman|🕺 dancing man|🧗 climbing|🧘 meditate yoga|🛀 bath|🛌 sleeping bed',
  ],
  [
    'nature',
    'Animals & nature',
    '🐻',
    '🐶 dog puppy|🐱 cat kitten|🐭 mouse|🐹 hamster|🐰 rabbit bunny|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🐤 baby chick|🦆 duck|🦅 eagle|🦉 owl|🦇 bat|🐺 wolf|🐗 boar|🐴 horse|🦄 unicorn|🐝 bee|🐛 caterpillar bug|🦋 butterfly|🐌 snail|🐞 ladybug|🐜 ant|🦗 cricket|🕷 spider|🦂 scorpion|🐢 turtle|🐍 snake|🦎 lizard|🦖 t-rex dinosaur|🦕 sauropod dinosaur|🐙 octopus|🦑 squid|🦐 shrimp|🦀 crab|🐡 blowfish|🐠 tropical fish|🐟 fish|🐬 dolphin|🐳 whale|🐋 whale|🦈 shark|🐊 crocodile|🐅 tiger|🐆 leopard|🦓 zebra|🦍 gorilla|🐘 elephant|🦛 hippo|🦏 rhino|🐪 camel|🦒 giraffe|🦘 kangaroo|🐃 buffalo|🐎 racehorse|🐖 pig|🐑 sheep|🦙 llama|🐐 goat|🦌 deer|🐕 dog|🐩 poodle|🦮 guide dog|🐈 cat|🐓 rooster|🦃 turkey|🦚 peacock|🦜 parrot|🦢 swan|🕊 dove peace|🐇 rabbit|🦝 raccoon|🦡 badger|🐁 mouse|🐀 rat|🐿 chipmunk|🦔 hedgehog|🌵 cactus|🎄 christmas tree|🌲 evergreen tree|🌳 tree|🌴 palm tree|🌱 seedling|🌿 herb|☘️ shamrock|🍀 four leaf clover luck|🎍 bamboo|🎋 tanabata|🍃 leaf wind|🍂 fallen leaves autumn|🍁 maple leaf|🍄 mushroom|🌾 rice sheaf|💐 bouquet|🌷 tulip|🌹 rose|🥀 wilted flower|🌺 hibiscus|🌸 cherry blossom|🌼 blossom|🌻 sunflower|🌞 sun face|🌝 full moon face|🌛 first quarter moon face|🌜 last quarter moon face|🌚 new moon face|🌕 full moon|🌖 waning gibbous|🌗 last quarter|🌘 waning crescent|🌑 new moon|🌒 waxing crescent|🌓 first quarter|🌔 waxing gibbous|🌙 crescent moon night|🌎 earth americas|🌍 earth africa|🌏 earth asia|💫 dizzy star|⭐ star|🌟 glowing star|✨ sparkles|⚡ zap lightning|☄️ comet|💥 collision boom|🔥 fire flame hot|🌪 tornado|🌈 rainbow|☀️ sun sunny|🌤 sun behind cloud|⛅ partly cloudy|☁️ cloud|🌧 rain|⛈ thunderstorm|🌨 snow|❄️ snowflake cold|☃️ snowman|⛄ snowman|🌬 wind|💨 dash wind|💧 droplet water|💦 sweat drops|☔ umbrella rain|🌊 wave ocean water',
  ],
  [
    'food',
    'Food & drink',
    '🍜',
    '🍏 green apple|🍎 apple|🍐 pear|🍊 tangerine orange|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🍈 melon|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwi|🍅 tomato|🍆 eggplant|🥑 avocado|🥦 broccoli|🥬 leafy green|🥒 cucumber|🌶 hot pepper spicy|🌽 corn|🥕 carrot|🧄 garlic|🧅 onion|🥔 potato|🍠 sweet potato|🥐 croissant|🥯 bagel|🍞 bread|🥖 baguette|🥨 pretzel|🧀 cheese|🥚 egg|🍳 cooking fried egg|🧈 butter|🥞 pancakes|🧇 waffle|🥓 bacon|🥩 steak meat|🍗 poultry leg|🍖 meat bone|🌭 hot dog|🍔 hamburger burger|🍟 fries|🍕 pizza|🥪 sandwich|🥙 stuffed flatbread|🧆 falafel|🌮 taco|🌯 burrito|🥗 salad|🥘 paella pan|🍲 stew pot|🍜 ramen noodles|🍝 spaghetti pasta|🍣 sushi|🍱 bento|🍛 curry|🍚 rice|🍙 rice ball|🍘 rice cracker|🥟 dumpling|🍤 fried shrimp|🥠 fortune cookie|🍥 fish cake|🥮 moon cake|🍢 oden|🍡 dango|🍧 shaved ice|🍨 ice cream|🍦 soft serve|🥧 pie|🧁 cupcake|🍰 shortcake|🎂 birthday cake|🍮 custard|🍭 lollipop|🍬 candy|🍫 chocolate|🍿 popcorn|🍩 doughnut|🍪 cookie|🌰 chestnut|🥜 peanuts|🍯 honey|🥛 milk|🍼 baby bottle|☕ coffee hot|🍵 tea|🧃 juice box|🥤 cup straw soda|🍶 sake|🍺 beer|🍻 beers cheers|🥂 clinking glasses toast|🍷 wine|🥃 whisky tumbler|🍸 cocktail|🍹 tropical drink|🧉 mate|🍾 champagne bottle|🧊 ice|🥄 spoon|🍴 fork knife|🍽 plate cutlery|🥣 bowl spoon|🥡 takeout box|🧂 salt',
  ],
  [
    'activity',
    'Activity',
    '⚽',
    '⚽ soccer football|🏀 basketball|🏈 american football|⚾ baseball|🥎 softball|🎾 tennis|🏐 volleyball|🏉 rugby|🥏 frisbee|🎱 8 ball pool|🪀 yo-yo|🏓 ping pong table tennis|🏸 badminton|🏒 ice hockey|🏑 field hockey|🥍 lacrosse|🏏 cricket|🥅 goal net|⛳ golf|🏹 bow arrow archery|🎣 fishing|🤿 diving mask|🥊 boxing glove|🥋 martial arts|🎽 running shirt|🛹 skateboard|🛷 sled|⛸ ice skate|🥌 curling|🎿 ski|⛷ skier|🏂 snowboarder|🏋️ weight lifting|🤼 wrestling|🤸 cartwheel gymnastics|⛹️ bouncing ball|🤺 fencing|🤾 handball|🏌️ golfing|🏇 horse racing|🧘 yoga meditation|🏄 surfing|🏊 swimming|🤽 water polo|🚣 rowing|🧗 climbing|🚵 mountain biking|🚴 cycling|🏆 trophy win|🥇 first place gold|🥈 second place silver|🥉 third place bronze|🏅 medal|🎖 military medal|🏵 rosette|🎗 ribbon|🎫 ticket|🎟 admission tickets|🎪 circus tent|🤹 juggling|🎭 performing arts theatre|🩰 ballet shoes|🎨 art palette|🎬 clapper film|🎤 microphone sing|🎧 headphones|🎼 musical score|🎹 piano keyboard|🥁 drum|🎷 saxophone|🎺 trumpet|🎸 guitar|🪕 banjo|🎻 violin|🎲 dice game|♟ chess pawn|🎯 dart bullseye target|🎳 bowling|🎮 video game controller|🎰 slot machine|🧩 puzzle piece',
  ],
  [
    'travel',
    'Travel & places',
    '🚀',
    '🚗 car|🚕 taxi|🚙 suv|🚌 bus|🚎 trolleybus|🏎 race car|🚓 police car|🚑 ambulance|🚒 fire engine|🚐 minibus|🚚 truck|🚛 lorry|🚜 tractor|🛴 scooter|🚲 bicycle bike|🛵 motor scooter|🏍 motorcycle|🚨 siren light|🚔 police car|🚍 oncoming bus|🚘 oncoming car|🚖 oncoming taxi|🚡 aerial tramway|🚠 mountain cableway|🚟 suspension railway|🚃 railway car|🚋 tram|🚞 mountain railway|🚝 monorail|🚄 bullet train|🚅 bullet train|🚈 light rail|🚂 locomotive steam|🚆 train|🚇 metro subway|🚊 tram|🚉 station|✈️ airplane plane|🛫 takeoff|🛬 landing|🛩 small plane|💺 seat|🛰 satellite|🚀 rocket launch|🛸 flying saucer ufo|🚁 helicopter|🛶 canoe|⛵ sailboat|🚤 speedboat|🛥 motor boat|🛳 passenger ship|⛴ ferry|🚢 ship|⚓ anchor|🚧 construction|⛽ fuel pump|🚏 bus stop|🗺 world map|🗿 moai statue|🗽 statue of liberty|🗼 tokyo tower|🏰 castle|🏯 japanese castle|🏟 stadium|🎡 ferris wheel|🎢 roller coaster|🎠 carousel|⛲ fountain|⛱ umbrella beach|🏖 beach|🏝 desert island|🏜 desert|🌋 volcano|⛰ mountain|🏔 snow mountain|🗻 mount fuji|🏕 camping|⛺ tent|🏠 house|🏡 house garden|🏘 houses|🏚 derelict house|🏗 construction crane|🏭 factory|🏢 office building|🏬 department store|🏣 post office|🏤 post office|🏥 hospital|🏦 bank|🏨 hotel|🏪 convenience store|🏫 school|🏩 love hotel|💒 wedding|🏛 classical building|⛪ church|🕌 mosque|🕍 synagogue|🕋 kaaba|⛩ shinto shrine|🛤 railway track|🛣 motorway|🗾 map of japan|🎑 moon ceremony|🏞 national park|🌅 sunrise|🌄 sunrise mountains|🌠 shooting star|🎇 sparkler|🎆 fireworks|🌇 sunset|🌆 cityscape dusk|🏙 cityscape|🌃 night stars|🌌 milky way|🌉 bridge night|🌁 foggy',
  ],
  [
    'objects',
    'Objects',
    '💡',
    '⌚ watch|📱 mobile phone|📲 phone arrow|💻 laptop computer|⌨️ keyboard|🖥 desktop computer|🖨 printer|🖱 mouse|🖲 trackball|🕹 joystick|🗜 clamp|💽 minidisc|💾 floppy disk save|💿 cd|📀 dvd|📼 videotape|📷 camera|📸 camera flash|📹 video camera|🎥 movie camera|📽 film projector|🎞 film frames|📞 telephone receiver|☎️ telephone|📟 pager|📠 fax|📺 television tv|📻 radio|🎙 studio microphone|🎚 level slider|🎛 control knobs|🧭 compass|⏱ stopwatch|⏲ timer|⏰ alarm clock|🕰 mantelpiece clock|⌛ hourglass done|⏳ hourglass|📡 satellite antenna|🔋 battery|🔌 electric plug|💡 light bulb idea|🔦 flashlight torch|🕯 candle|🪔 diya lamp|🧯 fire extinguisher|🛢 oil drum|💸 money wings|💵 dollar|💴 yen|💶 euro|💷 pound|💰 money bag|💳 credit card|💎 gem diamond|⚖️ balance scale|🧰 toolbox|🔧 wrench|🔨 hammer|⚒ hammer pick|🛠 hammer wrench tools|⛏ pick|🔩 nut bolt|⚙️ gear settings|🧱 brick|⛓ chains|🧲 magnet|🔫 water pistol|💣 bomb|🧨 firecracker|🪓 axe|🔪 knife|🗡 dagger|⚔️ crossed swords|🛡 shield|🚬 cigarette|⚰️ coffin|⚱️ funeral urn|🏺 amphora|🔮 crystal ball|📿 prayer beads|🧿 nazar amulet|💈 barber pole|⚗️ alembic|🔭 telescope|🔬 microscope|🕳 hole|💊 pill|💉 syringe|🩸 blood drop|🩹 bandage|🩺 stethoscope|🌡 thermometer|🧬 dna|🦠 microbe|🧫 petri dish|🧪 test tube|🧹 broom|🧺 basket|🧻 toilet paper|🚽 toilet|🚰 potable water|🚿 shower|🛁 bathtub|🧼 soap|🪒 razor|🧽 sponge|🪣 bucket|🔑 key|🗝 old key|🚪 door|🪑 chair|🛋 couch lamp|🛏 bed|🧸 teddy bear|🖼 framed picture|🛍 shopping bags|🛒 shopping cart|🎁 gift present|🎈 balloon|🎏 carp streamer|🎀 ribbon|🎊 confetti ball|🎉 party popper celebrate|🎎 japanese dolls|🏮 red lantern|🎐 wind chime|✉️ envelope mail|📩 envelope arrow|📨 incoming envelope|📧 email|💌 love letter|📥 inbox tray|📤 outbox tray|📦 package box|🏷 label tag|📪 closed mailbox|📫 closed mailbox raised|📬 open mailbox|📭 open mailbox lowered|📮 postbox|📯 postal horn|📜 scroll|📃 page curl|📄 page|📑 bookmark tabs|🧾 receipt|📊 bar chart|📈 chart increasing|📉 chart decreasing|🗒 spiral notepad|🗓 spiral calendar|📆 calendar|📅 date|🗑 wastebasket|📇 card index|🗃 card file box|🗳 ballot box|🗄 file cabinet|📋 clipboard|📁 folder|📂 open folder|🗂 dividers|🗞 rolled newspaper|📰 newspaper|📓 notebook|📔 notebook decorative|📒 ledger|📕 closed book|📗 green book|📘 blue book|📙 orange book|📚 books|📖 open book|🔖 bookmark|🧷 safety pin|🔗 link|📎 paperclip|🖇 linked paperclips|📐 triangular ruler|📏 straight ruler|🧮 abacus|📌 pushpin|📍 round pushpin|✂️ scissors|🖊 pen|🖋 fountain pen|✒️ black nib|🖌 paintbrush|🖍 crayon|📝 memo note|✏️ pencil|🔍 magnifying glass search|🔎 magnifying glass right|🔏 locked pen|🔐 locked key|🔒 locked|🔓 unlocked',
  ],
  [
    'symbols',
    'Symbols',
    '❤️',
    '❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|💔 broken heart|❣️ heart exclamation|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 heart arrow|💝 heart ribbon|💟 heart decoration|☮️ peace|✝️ latin cross|☪️ star crescent|🕉 om|☸️ wheel dharma|✡️ star of david|🔯 six pointed star|🕎 menorah|☯️ yin yang|☦️ orthodox cross|🛐 place of worship|⛎ ophiuchus|♈ aries|♉ taurus|♊ gemini|♋ cancer|♌ leo|♍ virgo|♎ libra|♏ scorpio|♐ sagittarius|♑ capricorn|♒ aquarius|♓ pisces|🆔 id|⚛️ atom|🉑 acceptable|☢️ radioactive|☣️ biohazard|📴 mobile off|📳 vibration mode|🈶 not free|🈚 free|🈸 application|🈺 open for business|🈷️ monthly amount|✴️ eight pointed star|🆚 versus vs|💮 white flower|🉐 bargain|㊙️ secret|㊗️ congratulations|🈴 passing grade|🈵 no vacancy|🈹 discount|🈲 prohibited|🅰️ a button|🅱️ b button|🆎 ab button|🆑 cl button|🅾️ o button|🆘 sos help|❌ cross mark no|⭕ hollow circle|🛑 stop sign|⛔ no entry|📛 name badge|🚫 prohibited|💯 hundred points|💢 anger symbol|♨️ hot springs|🚷 no pedestrians|🚯 no littering|🚳 no bicycles|🚱 non potable water|🔞 no one under 18|📵 no mobile phones|❗ exclamation|❕ white exclamation|❓ question|❔ white question|‼️ double exclamation|⁉️ exclamation question|🔅 dim button|🔆 bright button|〽️ part alternation|⚠️ warning|🚸 children crossing|🔱 trident|⚜️ fleur de lis|🔰 beginner|♻️ recycle|✅ check mark button yes|🈯 reserved|💹 chart yen|❇️ sparkle|✳️ eight spoked asterisk|❎ cross mark button|🌐 globe meridians|💠 diamond dot|Ⓜ️ circled m|🌀 cyclone|💤 zzz sleep|🏧 atm|🚾 water closet|♿ wheelchair accessible|🅿️ parking|🈳 vacancy|🈂️ service charge|🛂 passport control|🛃 customs|🛄 baggage claim|🛅 left luggage|🚹 mens room|🚺 womens room|🚼 baby symbol|🚻 restroom|🚮 litter bin|🎦 cinema|📶 signal bars|🈁 here|🔣 input symbols|ℹ️ information|🔤 input latin letters|🔡 input lowercase|🔠 input uppercase|🆖 ng button|🆗 ok button|🆙 up button|🆒 cool button|🆕 new button|🆓 free button|0️⃣ zero|1️⃣ one|2️⃣ two|3️⃣ three|4️⃣ four|5️⃣ five|6️⃣ six|7️⃣ seven|8️⃣ eight|9️⃣ nine|🔟 ten|🔢 input numbers|#️⃣ hash|*️⃣ asterisk|⏏️ eject|▶️ play|⏸ pause|⏯ play pause|⏹ stop|⏺ record|⏭ next track|⏮ previous track|⏩ fast forward|⏪ rewind|🔀 shuffle|🔁 repeat|🔂 repeat one|◀️ reverse|🔼 up small|🔽 down small|⏫ fast up|⏬ fast down|➡️ right arrow|⬅️ left arrow|⬆️ up arrow|⬇️ down arrow|↗️ up right arrow|↘️ down right arrow|↙️ down left arrow|↖️ up left arrow|↕️ up down arrow|↔️ left right arrow|↪️ right hook arrow|↩️ left hook arrow|⤴️ arrow curving up|⤵️ arrow curving down|🔃 clockwise arrows|🔄 counterclockwise arrows|🔚 end|🔙 back|🔛 on|🔝 top|🔜 soon|🔘 radio button|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🟤 brown circle|🔺 red triangle up|🔻 red triangle down|🔸 small orange diamond|🔹 small blue diamond|🔶 large orange diamond|🔷 large blue diamond|🔳 white square button|🔲 black square button|▪️ black small square|▫️ white small square|◾ black medium small square|◽ white medium small square|◼️ black medium square|◻️ white medium square|🟥 red square|🟧 orange square|🟨 yellow square|🟩 green square|🟦 blue square|🟪 purple square|⬛ black large square|⬜ white large square|🟫 brown square|🔈 speaker low|🔇 muted speaker|🔉 speaker medium|🔊 speaker high|🔔 bell|🔕 bell slash mute|📣 megaphone|📢 loudspeaker|👁‍🗨 eye speech bubble|💬 speech balloon|💭 thought balloon|🗯 anger balloon|♠️ spade|♣️ club|♥️ heart suit|♦️ diamond suit|🃏 joker|🎴 flower cards|🀄 mahjong|🕐 one oclock|🕑 two oclock|🕒 three oclock|🕓 four oclock|🕔 five oclock|🕕 six oclock',
  ],
];

export const EMOJI_CATEGORIES: EmojiCategory[] = RAW.map(([id, label, icon, blob]) => ({
  id,
  label,
  icon,
  items: blob.split('|').map((entry) => {
    const gap = entry.indexOf(' ');
    return { glyph: entry.slice(0, gap), keywords: entry.slice(gap + 1) };
  }),
}));

export const ALL_EMOJI = EMOJI_CATEGORIES.flatMap((c) => c.items);

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '🙏', '😮'];

/** Skin tone modifiers, applied to the hand and person glyphs that accept them. */
export const SKIN_TONES = ['', '🏻', '🏼', '🏽', '🏾', '🏿'];

const TONEABLE =
  /^(👋|🤚|🖐|✋|🖖|👌|🤏|✌️|🤞|🤟|🤘|🤙|👈|👉|👆|👇|☝️|👍|👎|✊|👊|🤛|🤜|👏|🙌|👐|🤲|🙏|✍️|💅|🤳|💪|👶|🧒|👦|👧|🧑|👨|👩|🧓|👴|👵|🙍|🙎|🙅|🙆|💁|🙋|🧏|🙇|🤦|🤷|👮|🕵️|💂|👷|🤴|👸|👳|🧕|🤵|👰|🤰|💆|💇|🚶|🏃|💃|🕺|🧗|🧘|🛀|🛌)$/u;

export function applySkinTone(glyph: string, tone: string): string {
  if (!tone || !TONEABLE.test(glyph)) return glyph;
  return glyph + tone;
}

export function searchEmoji(query: string, tone = ''): { glyph: string; keywords: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: typeof ALL_EMOJI = [];
  const contains: typeof ALL_EMOJI = [];
  for (const e of ALL_EMOJI) {
    const words = e.keywords.split(' ');
    if (words.some((w) => w.startsWith(q))) starts.push(e);
    else if (e.keywords.includes(q)) contains.push(e);
  }
  return [...starts, ...contains]
    .slice(0, 80)
    .map((e) => ({ ...e, glyph: applySkinTone(e.glyph, tone) }));
}
