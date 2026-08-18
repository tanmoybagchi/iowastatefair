'use strict';
/*
 * source-manual.js — data hand-encoded from the Iowa State Fair's *designed* PDFs.
 *
 * Everything here comes from one of three official documents whose text is converted to
 * outlines for print, so nothing can be extracted programmatically (unlike the generated
 * reports handled by parse-reports.js):
 *
 *   [MAP]   Maps/2026-Website-Final.pdf           — fairgrounds map + landmark index w/ grid refs
 *   [WATER] Maps/2026_WaterRefillStationMap.pdf   — water fountain / refill station list
 *   [NEW]   2026/2026-New-Food-Brochure-Website.pdf — new foods, People's Choice rankings
 *
 * Each block below cites its source. These sets are small and change once a year, unlike the
 * ~3,000 menu items, so hand-encoding is the right trade here.
 */

// ---------------------------------------------------------------------------
// Fair-wide facts.  Source: iowastatefair.org homepage + /visit/fair-hours
// ---------------------------------------------------------------------------

const FAIR = {
  year: 2026,
  theme: 'Fair Spirit',
  startDate: '2026-08-13',
  endDate: '2026-08-23',
  address: '3000 East Grand Ave, Des Moines, Iowa 50317',
  phone: '800.545.FAIR',
  // Verbatim from /visit/fair-hours. Times are "subject to change" per the fair.
  hours: [
    {
      days: 'August 13–22',
      grounds: '8 a.m. to midnight',
      buildings: '9 a.m. to 8 p.m.',
      thrill: [
        ['Thrill Ville', '11 a.m. to 11 p.m.'],
        ['Thrill Town', '10 a.m. to 10 p.m.'],
        ['Thrill Zone', '10 a.m. to 11 p.m.'],
      ],
      note: 'After 10 p.m. there are no on-site ticket sales or entry/re-entry at the gates.',
    },
    {
      days: 'August 23',
      grounds: '8 a.m. to 9 p.m.',
      buildings: '9 a.m. to 8 p.m.',
      thrill: [
        ['Thrill Ville', '11 a.m. to 9 p.m.'],
        ['Thrill Town', '10 a.m. to 9 p.m.'],
        ['Thrill Zone', '10 a.m. to 9 p.m.'],
      ],
      note: 'After 7 p.m. there are no on-site ticket sales or entry/re-entry at the gates.',
    },
  ],
  newFoodVoting: 'People’s Choice voting closed 11:59 p.m. Wednesday, August 19.',
};

// ---------------------------------------------------------------------------
// Landmark grid references.  Source: [MAP] page 2 index, verbatim.
//
// The map overlays a lettered/numbered grid (rows A–O, columns 1–25). build-data.js fits an
// affine transform from grid -> lat/lng using landmarks that ALSO have an OpenStreetMap
// footprint, then uses it for the ones that don't.
//
// `est: true` marks a landmark that is NOT in the printed index — its grid cell was read off
// the map artwork instead. Those are less precise and are reported separately by the QA pass.
// ---------------------------------------------------------------------------

const LANDMARK_GRID = {
  // --- Entertainment (indexed) ---
  'Anne & Bill Riley Stage': 'I12',
  'Elwell Family Park': 'D4',
  'Expo Hill': 'H20',
  'Fun Forest': 'H17',
  'Fun Forest Stage': 'H17',
  'Grandstand': 'F10',
  'MidAmerican Energy Stage': 'I18',
  'The Lawn': 'L6',
  'Susan Knapp Amphitheater': 'F19',

  // --- Livestock judging / shows (indexed) ---
  'Outdoor Arena': 'N19',
  'Livestock Pavilion': 'J15',
  'Poultry and Rabbit Building': 'E22',
  'Jacobson Exhibition Center': 'L10',
  'Sheep Barn': 'N11',
  'Swine Barn': 'N16',

  // --- Fair day events (indexed) ---
  'Administration Building': 'H13',
  'Agriculture Building': 'H16',
  'Alliant Energy Landing': 'J16',
  'Animal Learning Center': 'F17',
  'Avenue of Breeds': 'M6',
  'Country School': 'F21',
  'Cultural Center': 'J20',
  'DNR Building': 'G5',
  'First Aid Center': 'G18',
  'First Church': 'G20',
  'Food Center': 'J2',
  '4-H Exhibits Building': 'N8',
  'The Garden': 'D17',
  'Grandfather’s Barn': 'J23',
  'Horse Barn': 'L12',
  'ISF Hub': 'N2',
  'Iowa State Fair Police': 'H4',
  'Legacy Terrace': 'G10',
  'Little Hands on the Farm': 'E17',
  'The Marketplaces': 'F10',
  'Maytag Family Theaters': 'G6',
  'Museum Complex': 'G23',
  'Parking Office': 'A3',
  'Pioneer Hall': 'H22',
  'Ruan Plaza': 'I10',
  'Sale Ring': 'L16',
  'Service Center': 'H11',
  'Shivers Plaza': 'K14',
  'Stalling Barn': 'N21',
  'Thrill Town': 'K6',
  'Thrill Ville': 'E14',
  'Thrill Zone': 'F3',
  'Varied Industries Building': 'H8',
  'Walnut Center': 'K12',
  'Wind Turbine & Education Center': 'H19',
  'Ye Old Mill': 'F14',
  'Youth Inn': 'M20',
  'Cattle Barn': 'L16',
  'Sky Glider East': 'G14',
  'Sky Glider West': 'K13',
  'Grand Concourse': 'G8',          // index gives a range G3–14; midpoint used
  'Campgrounds Entrance': 'E24',    // index gives E24/I24; first used

  // --- Read off the map artwork (not in the printed index) ---
  'Triangle': { grid: 'H14', est: true },            // wedge just east of Administration Bldg
  'Walnut Square': { grid: 'K11', est: true },
  'Giant Slide': { grid: 'J10', est: true },
  'Snakes Alive': { grid: 'J13', est: true },
  'Central Iowa Railroad Club': { grid: 'K13', est: true },
  'FFA': { grid: 'K10', est: true },
  'Cattlemen’s Beef Quarters': { grid: 'K12', est: true },
  'Stockman’s Inn': { grid: 'L15', est: true },
  'Old West BBQ': { grid: 'K13', est: true },
  'The Bud Tent': { grid: 'F16', est: true },
  'Iowa Pork Tent': { grid: 'F17', est: true },
  'Sheri Avis Horner Pavilion': { grid: 'J17', est: true },
  'Pella Plaza': { grid: 'I16', est: true },
  'Gammon Barn': { grid: 'J17', est: true },
  'Discovery Garden': { grid: 'I15', est: true },
  'Sculpture': { grid: 'J10', est: true },
  'Ticket Office': { grid: 'F11', est: true },
  'East Marketplace': { grid: 'F11', est: true },
  'Central Marketplace': { grid: 'F10', est: true },
  'West Marketplace': { grid: 'F9', est: true },
  'Boulevard of Dairy Breeds': { grid: 'L15', est: true },
  'Milking Parlor': { grid: 'L16', est: true },
  'Super Bull': { grid: 'L15', est: true },
  'Variety Star Playground': { grid: 'H17', est: true },
  'The Bird’s Nest': { grid: 'I18', est: true },
  'Bubbly Bar & Bistro': { grid: 'J22', est: true },
  'Butter Cow': { grid: 'G16', est: true },
  'Hillcrest Dorm': { grid: 'K21', est: true },
  'Ice & Feed': { grid: 'K24', est: true },
  'Horseshoe Courts': { grid: 'H23', est: true },
  'Heritage Village': { grid: 'F22', est: true },
  'Mountain Man Camp': { grid: 'E20', est: true },
  'Fire Station': { grid: 'E21', est: true },
  'Print Shop': { grid: 'D21', est: true },
  'Maintenance Building': { grid: 'E16', est: true },
  'Sandra Freeman Dowie Midway Plaza': { grid: 'F13', est: true },
  'Barksdale’s State Fair Cookies': { grid: 'G8', est: true },
  'Blue Ribbon Bar & Eatery': { grid: 'G12', est: true },
  'Jalapeño Pete’s': { grid: 'G13', est: true },
  'JR’s South Pork Ranch': { grid: 'J13', est: true },
  'The Depot': { grid: 'H5', est: true },
  'WHO Crystal Studio': { grid: 'H4', est: true },
  'Warm-Up Arena': { grid: 'M19', est: true },
  'Cattle Tie-Outs': { grid: 'N23', est: true },
  'Big Boar': { grid: 'N15', est: true },
  'Big Ram': { grid: 'N12', est: true },
  'Horse Annex': { grid: 'N10', est: true },
  'Transit Hub': { grid: 'L2', est: true },
  'Iowa Craft Beer Tent': { grid: 'L4', est: true },
  'Jacobson Plaza': { grid: 'K5', est: true },
  'Iowa Veterans Memorial Walkway': { grid: 'H19', est: true },
  'Pepsi Clock': { grid: 'G13', est: true },
  'Machinery Grounds Plaza': { grid: 'H9', est: true },
  'Soda Fountain': { grid: 'G16', est: true },
  'Rock Island Avenue': { grid: 'K15', est: true },
  'Midway': { grid: 'E14', est: true },
  'Guest Services': { grid: 'K6', est: true },

  // --- Gates (all present on the map artwork) ---
  'Gate 1': { grid: 'A13', est: true },
  'Gate 2A': { grid: 'A15', est: true },
  'Gate 2B': { grid: 'A24', est: true },
  'Gate 4': { grid: 'E25', est: true },
  'Gate 5': { grid: 'I25', est: true },
  'Gate 6': { grid: 'O21', est: true },
  'Gate 7': { grid: 'O18', est: true },
  'Gate 8': { grid: 'O14', est: true },
  'Gate 9': { grid: 'N2', est: true },
  'Gate 10': { grid: 'K1', est: true },
  'Gate 11': { grid: 'G1', est: true },
  'Gate 13': { grid: 'B2', est: true },
  'Gate 13A': { grid: 'A2', est: true },
  'Gate 15': { grid: 'C15', est: true },
  'Gate 16': { grid: 'C17', est: true },
};

// ---------------------------------------------------------------------------
// Aliases: how the vendor reports refer to landmarks -> canonical landmark name.
//
// The vendor PDFs write locations as free prose ("SW of Ag Bldg", "West of Jacobson
// Exhibition Center", "on Small Triangle SW of Admin Bldg"). These map the shorthand to the
// canonical names used by LANDMARK_GRID and by the OpenStreetMap footprints.
// Longest match wins, so more specific keys can safely overlap shorter ones.
// ---------------------------------------------------------------------------

const ALIASES = {
  'ag bldg': 'Agriculture Building',
  'ag building': 'Agriculture Building',
  'agriculture building': 'Agriculture Building',
  'vi bldg': 'Varied Industries Building',
  'vi building': 'Varied Industries Building',
  'varied industries': 'Varied Industries Building',
  'admin bldg': 'Administration Building',
  'administration bldg': 'Administration Building',
  'administration building': 'Administration Building',
  'riley stage': 'Anne & Bill Riley Stage',
  'anne & bill riley stage': 'Anne & Bill Riley Stage',
  'knapp stage': 'Susan Knapp Amphitheater',
  'susan knapp amphitheater': 'Susan Knapp Amphitheater',
  'susan knapp': 'Susan Knapp Amphitheater',
  'jacobson exhibition center': 'Jacobson Exhibition Center',
  'jacobson bldg': 'Jacobson Exhibition Center',
  'jacobson': 'Jacobson Exhibition Center',
  'exhibition center': 'Jacobson Exhibition Center',
  'jacobson lawn': 'Jacobson Plaza',
  'jacobson plaza': 'Jacobson Plaza',
  'old mill': 'Ye Old Mill',
  'ye old mill': 'Ye Old Mill',
  'animal learning center': 'Animal Learning Center',
  'learning center': 'Animal Learning Center',
  'alc': 'Animal Learning Center',
  'little hands': 'Little Hands on the Farm',
  'little hands on the farm': 'Little Hands on the Farm',
  'livestock pavilion': 'Livestock Pavilion',
  'pavilion': 'Livestock Pavilion',
  'grandstand': 'Grandstand',
  'grand stand': 'Grandstand',
  'giant slide': 'Giant Slide',
  'walnut square': 'Walnut Square',
  'walnut center': 'Walnut Center',
  'triangle': 'Triangle',
  'service center': 'Service Center',
  'horse barn': 'Horse Barn',
  'sheep barn': 'Sheep Barn',
  'swine barn': 'Swine Barn',
  'cattle barn': 'Cattle Barn',
  'baby beef barn': 'Cattle Barn',
  'dairy parlor': 'Milking Parlor',
  'dairy barn': 'Milking Parlor',
  'stalling barn': 'Stalling Barn',
  'pioneer hall': 'Pioneer Hall',
  'cultural center': 'Cultural Center',
  'culture center': 'Cultural Center',
  'cultural center courtyard': 'Cultural Center',
  'culture center courtyard': 'Cultural Center',
  'dnr bldg': 'DNR Building',
  'dnr building': 'DNR Building',
  'thrillville': 'Thrill Ville',
  'thrill ville': 'Thrill Ville',
  'thrilltown': 'Thrill Town',
  'thrill town': 'Thrill Town',
  'thrillzone': 'Thrill Zone',
  'thrill zone': 'Thrill Zone',
  'midway': 'Midway',
  'ruan plaza': 'Ruan Plaza',
  'machinery grounds plaza': 'Machinery Grounds Plaza',
  'central marketplace': 'Central Marketplace',
  'west marketplace': 'West Marketplace',
  'east marketplace': 'East Marketplace',
  'soda fountain': 'Soda Fountain',
  'heritage area': 'Heritage Village',
  'heritage village': 'Heritage Village',
  'red cross': 'First Aid Center',
  'first aid': 'First Aid Center',
  'shivers plaza': 'Shivers Plaza',
  'pella plaza': 'Pella Plaza',
  'the lawn': 'The Lawn',
  'iowa craft beer tent': 'Iowa Craft Beer Tent',
  'blue ribbon bar & eatery': 'Blue Ribbon Bar & Eatery',
  'jr’s south pork ranch': 'JR’s South Pork Ranch',
  'jr\'s south pork ranch': 'JR’s South Pork Ranch',
  'stockman’s inn': 'Stockman’s Inn',
  'stockman\'s inn': 'Stockman’s Inn',
  'cattlemen’s beef quarters': 'Cattlemen’s Beef Quarters',
  'cattlemens beef quarters': 'Cattlemen’s Beef Quarters',
  'ffa': 'FFA',
  'grand concourse': 'Grand Concourse',
  'grand ave': 'Grand Concourse',
  'grand avenue': 'Grand Concourse',
  // Bare "Grand" is common ("N. side of Grand, Front of Grandstand"). Word-boundary matching
  // keeps this from firing inside "Grandstand".
  'grand': 'Grand Concourse',
  'r.i. ave': 'Rock Island Avenue',
  'ri ave': 'Rock Island Avenue',
  'rock island ave': 'Rock Island Avenue',
  'rock island': 'Rock Island Avenue',
  'elwell family park': 'Elwell Family Park',
  'food center': 'Food Center',
  'youth inn': 'Youth Inn',
  '4-h exhibits building': '4-H Exhibits Building',
  'guest services': 'Guest Services',
  'sky glider east': 'Sky Glider East',
  'sky glider west': 'Sky Glider West',
  'open arena': 'Outdoor Arena',
  'outdoor arena': 'Outdoor Arena',
  'warm-up arena': 'Warm-Up Arena',
  'the garden': 'The Garden',
  'expo hill': 'Expo Hill',
  'fun forest': 'Fun Forest',
  'first church': 'First Church',
  'country school': 'Country School',
  'museum complex': 'Museum Complex',
  'poultry/rabbit building': 'Poultry and Rabbit Building',
  'grandfather’s barn': 'Grandfather’s Barn',
  'gammon barn': 'Gammon Barn',
  'legacy terrace': 'Legacy Terrace',
  'isf hub': 'ISF Hub',
  'transit hub': 'Transit Hub',
  'isf police': 'Iowa State Fair Police',

  // Spellings and informal names that appear only in the vendor reports.
  'conservation bldg': 'DNR Building',          // the DNR building's older name
  'conservation building': 'DNR Building',
  'livestock pavillion': 'Livestock Pavilion',  // misspelled in both the report and OSM
  'midamerican stage': 'MidAmerican Energy Stage',
  'midamerican energy stage': 'MidAmerican Energy Stage',

  // A few stands have no separate location label in the report, so their own stand name ends
  // up in the location field ("BUD TENT-FOOD", "OLD WEST ROADHOUSE BBQ"). They are all named
  // after the landmark they sit at, so aliasing the name resolves them.
  'bud tent': 'The Bud Tent',
  'old west roadhouse': 'Old West BBQ',
  'old west bbq': 'Old West BBQ',
  'ska stage': 'Susan Knapp Amphitheater',   // SKA = Susan Knapp Amphitheater
};

for (let n = 1; n <= 16; n++) ALIASES[`gate ${n}`] = `Gate ${n}`;
ALIASES['gate 2a'] = 'Gate 2A';
ALIASES['gate 2b'] = 'Gate 2B';
ALIASES['gate 13a'] = 'Gate 13A';

// ---------------------------------------------------------------------------
// Water.  Source: [WATER], verbatim building list and in-building detail.
//
// `kind` is 'both' where the map shows a fountain AND a bottle-refill icon, 'fountain' where
// it shows only a fountain, and 'booth' for the paid Blue Ribbon Foundation water booths.
// `landmark` keys into LANDMARK_GRID / the OSM footprints for positioning.
// ---------------------------------------------------------------------------

const WATER = [
  { landmark: '4-H Exhibits Building', kind: 'both', detail: 'By bathrooms inside main area and lobby' },
  { landmark: 'Animal Learning Center', kind: 'both', detail: 'Between the restrooms' },
  { landmark: 'Cultural Center', kind: 'both', detail: 'North and south ends of building, by family bathrooms on all three floors' },
  { landmark: 'Food Center', kind: 'both', detail: 'Inside and outside, between bathrooms (Elwell Family Food Center)' },
  { landmark: 'Grandstand', kind: 'fountain', detail: 'Inside restroom on each side; four on the upstairs mezzanine' },
  { landmark: 'Horse Barn', kind: 'fountain', detail: 'Middle of barn, between aisles D & I' },
  { landmark: 'Jacobson Exhibition Center', kind: 'fountain', detail: 'By each restroom on north and south ends of the building' },
  { landmark: 'Pella Plaza', kind: 'fountain', detail: 'West end, by bronze sculptures' },
  { landmark: 'Service Center', kind: 'fountain', detail: 'Between the restrooms' },
  { landmark: 'Sheep Barn', kind: 'fountain', detail: 'Northeast and northwest sides, near the new restrooms' },
  { landmark: 'Stalling Barn', kind: 'fountain', detail: 'Middle of the main aisle' },
  { landmark: 'Shivers Plaza', kind: 'fountain', detail: 'Right side of men’s restrooms (Ron and Bev Shivers Family Plaza)' },
  { landmark: 'Thrill Ville', kind: 'fountain', detail: 'On east side of entrance near the Sky Glider loading area' },
  { landmark: 'Varied Industries Building', kind: 'both', detail: 'South hallway and upstairs by the restrooms' },
  { landmark: 'Youth Inn', kind: 'both', detail: 'North and south ends of building, lower level' },

  // Blue Ribbon Foundation water booths — bottled water for sale, not free refill.
  { landmark: 'Heritage Village', kind: 'booth', detail: 'Blue Ribbon Foundation water booth' },
  { landmark: 'Cattle Barn', kind: 'booth', detail: 'Blue Ribbon Foundation water booth' },
  { landmark: 'Agriculture Building', kind: 'booth', detail: 'Blue Ribbon Foundation water booth' },
  { landmark: 'Anne & Bill Riley Stage', kind: 'booth', detail: 'Blue Ribbon Foundation water booth' },
  { landmark: 'Little Hands on the Farm', kind: 'booth', detail: 'Blue Ribbon Foundation water booth' },
  { landmark: 'Thrill Town', kind: 'booth', detail: 'Blue Ribbon Foundation water booth' },
  { landmark: 'Service Center', kind: 'booth', detail: 'Blue Ribbon Foundation water booth' },
];

// ---------------------------------------------------------------------------
// Restrooms inside buildings.  Source: [WATER], read for what it says about restrooms.
//
// The fair's map marks ~40 restrooms with an icon, and those icon positions are NOT transcribed
// here for the reason given at the amenity legend below. But the water map's in-building detail
// names the building each fountain sits in *relative to its restrooms* — "between the restrooms",
// "by each restroom on north and south ends" — which is the fair's own document stating that this
// building has restrooms. That's evidence for the building, not for a point inside it, so these
// land on the footprint centroid like the water points do, and the UI says "in the <building>".
//
// `detail` is written from the restroom's point of view. Reusing the water strings verbatim reads
// backwards on a restroom row: "Right side of men's restrooms" describes where the *fountain* is.
//
// This list is 10 buildings; with the 8 OSM-surveyed standalone restrooms the build adds, the app
// holds 18 of ~40. Deliberately incomplete, and the chip says so.
// ---------------------------------------------------------------------------

const RESTROOMS = [
  { landmark: '4-H Exhibits Building', detail: 'Inside the main area, and off the lobby' },
  { landmark: 'Animal Learning Center', detail: 'Inside the building' },
  { landmark: 'Cultural Center', detail: 'North and south ends, all three floors; family restrooms' },
  { landmark: 'Food Center', detail: 'Inside the Elwell Family Food Center' },
  { landmark: 'Grandstand', detail: 'One on each side, plus the upstairs mezzanine' },
  { landmark: 'Jacobson Exhibition Center', detail: 'North and south ends of the building' },
  { landmark: 'Service Center', detail: 'Inside the Service Center' },
  { landmark: 'Sheep Barn', detail: 'Northeast and northwest sides — the new restrooms' },
  { landmark: 'Shivers Plaza', detail: 'Men’s and women’s, at the plaza' },
  { landmark: 'Varied Industries Building', detail: 'South hallway, and upstairs' },
];

// ---------------------------------------------------------------------------
// New foods.  Source: [NEW].
//
// RANKED holds the People's Choice finalists (1–3) and semi-finalists (4–11) with the
// brochure's own descriptions and prices. NEW_ITEMS is the brochure's full "New Food List" —
// every vendor and the items they debuted in 2026 — used to flag items as new in search.
// Item names are given as printed; build-data.js matches them to menu items case-insensitively
// and reports any that don't match.
// ---------------------------------------------------------------------------

const RANKED = [
  { rank: 1, tier: 'finalist', name: 'All-American Scrambled Egg Roll', vendor: 'Winn & Sara’s Kitchen', price: '$15', desc: 'Thick-cut smoky bacon, savory sausage, hearty hash browns, farm-fresh fluffy scrambled eggs and melted cheddar cheese wrapped in the signature crispy golden egg roll, finished with a rich drizzle of homemade cheesy ranch.' },
  { rank: 2, tier: 'finalist', name: 'Ultimate Minneapple Pie', vendor: 'Minneapple Pie', price: '$14', desc: 'Deep fried apple pie served with vanilla and cinnamon ice cream drizzled with homemade apple syrup.' },
  { rank: 3, tier: 'finalist', name: 'Porky Parm Gnocchi', vendor: 'Destination Grille', price: '$14', desc: 'Gluten-free potato gnocchi and Graziano sausage tossed in a house-made AE cream parmesan sauce with a pesto drizzle, shaved parmesan, fresh parsley and topped with an America 250th year flag and a souvenir piggy pal.' },
  { rank: 4, tier: 'semi-finalist', name: 'Sweet Americana', vendor: 'Over the Top', price: '$13', award: 'Best Red, White and Blue Food', desc: 'Strawberry shortcake, lemon bar and blueberry crisp ice creams, each topped with a signature garnish: a shortcake cookie, a lemon bar square and chocolate-covered blueberries.' },
  { rank: 5, tier: 'semi-finalist', name: 'Garlic Dill Pickle Cheese Curds', vendor: 'Brad and Harry’s Cheese Curds', price: '$9', desc: 'A mashup of cheese curd goodness. Combining their two most popular flavors, garlic and dill pickle to make a new flavored cheese curd!' },
  { rank: 6, tier: 'semi-finalist', name: 'Crunchy Lamb Wrap', vendor: 'HoQ', price: '$19', desc: 'Homemade naan bread stuffed with creamy risotto, braised Iowa lamb, local cheese, creme fraiche and local greens; breaded and deep fried; served with watermelon ranch sauce.' },
  { rank: 7, tier: 'semi-finalist', name: 'Star Spangled Swine', vendor: 'Whatcha Smokin? BBQ', price: '$15', desc: 'Prime grade pork belly with apple chipotle rub, signature big red soda glaze; rolled in blue and white honey crystals.' },
  { rank: 8, tier: 'semi-finalist', name: '1776 Dubai Strawberries', vendor: 'The Strawberry Station', price: '$19', desc: 'Milk chocolate poured over fresh strawberries topped with a rich pistachio crème and sprinkled with Kataifi (a roasted Middle Eastern phyllo dough).' },
  { rank: 9, tier: 'semi-finalist', name: 'Cajun Cluck ‘N’ Chaos', vendor: 'Cluckin’ Coop', price: '$14', desc: 'A Cajun-style chicken sloppy joe piled high on a buttery brioche bun, loaded with crunchy sweet pepper coleslaw and fiery spicy pickles. Topped with a skewer stacked with a tangy pickled egg and extra pickles, finished with a cloud of lime-infused pickle cotton candy.' },
  { rank: 10, tier: 'semi-finalist', name: 'Stuffed Tater Kegs', vendor: 'Tater Todd and Hot Doug’s', price: '$10', desc: '2 options: The Breakfast Skillet Tater Keg filled with eggs, sausage, and cheddar cheese, or the vegetarian Cheese Bomb Tater Keg, loaded with creamy cheddar cheese and sour cream.' },
  { rank: 11, tier: 'semi-finalist', name: 'Strawberry Bliss', vendor: 'Iowa Specialty Crop Growers Association', price: '$8', desc: 'A buttery shortbread cookie topped with a plump, juicy strawberry enveloped in a cloud of fluffy meringue and covered in creamy milk chocolate, drizzled with white chocolate and finished with a sprinkle of fresh-cut strawberries.' },
];

/** The brochure's full 2026 new-food list: vendor -> items debuted this year. */
const NEW_ITEMS = {
  'Winn & Sara’s Kitchen': ['All-American Scrambled Egg Roll'],
  'Minneapple Pie': ['Ultimate Minneapple Pie', 'Deep Fried Cookie Dough Pie'],
  'Destination Grille': ['Porky Parm Gnocchi', 'Mozza-Tini'],
  'Over the Top': ['Sweet Americana'],
  'Brad and Harry’s Cheese Curds': ['Garlic Dill Pickle Cheese Curds'],
  'HoQ': ['Crunchy Lamb Wrap'],
  'Whatcha Smokin? BBQ': ['Star Spangled Swine'],
  'The Strawberry Station': ['1776 Dubai Strawberries', 'Belgian Chocolate Covered Strawberries'],
  'Cluckin’ Coop': ['Cajun Cluck ‘N’ Chaos', 'Cluck Yeah Hush Puppies'],
  'Tater Todd and Hot Doug’s': ['Stuffed Tater Kegs'],
  'Iowa Specialty Crop Growers Assocation': ['Strawberry Bliss'],
  'Applishus': ['Firecracker Churros'],
  'Bao Bao’s Tanghulu': ['Tanghulu', 'Zower Sour Tanghulu'],
  'Bauder’s Ice Cream': ['Patriotic Molten Lava Celebration'],
  'Big Acai Bowls': ['Fuego Bowl'],
  'The Bird’s Nest': ['Amaretto Ice Cream, Cake Batter with Chocolate Cake Balls and Birthday Cake Batter Ice Cream'],
  'Biscuit Bar': ['Affogato', 'Italian Hand Pies'],
  'Blue Ribbon Bar & Eatery': ['The 1776 Liberty Bowl'],
  'Bubbly': ['1776 Parmesan Ice Cream'],
  'Buni’s Cinnamon Rolls': ['Caramel Apple Crumble Cinnamon Roll', 'Pecan Caramel Apple Crumble Cinnamon Roll'],
  'Burrito Bobo': ['Flamin’ Hot Cheetos® Breakfast Burrito'],
  'Carl’s Gizmo': ['Spicy Italian Sausage Dog'],
  'Cattlemen’s Beef Quarters': ['Pastrami Burger'],
  'Chuckie’s Famous Breaded Pork Tenderloins': ['Hot Honey Chicken Wrap'],
  'Coney Corner': ['Butter Dipped Ice Cream Cone'],
  'Dairy Zone': ['Oreo® Overload Nachos', 'Patriotic Nachos', 'This Little Piggy Tornado'],
  'Dough Crazy': ['Butterfinger Ice Cream Bar', 'Dough-Noli'],
  'GoldenKDog': ['Cinnamozza Kdog'],
  'Grater Taters': ['Hawaiian Ricotta Ravioli'],
  'Hagar’s Hoagies': ['French Silk Cannoli'],
  'Its Dough Time': ['Homestead Bites', 'Star-Spangled'],
  'Jalapeno Pete’s': ['Pete’s Southwest Salad'],
  'Josephine’s Glazed Doughnuts': ['Hand Rolled Pretzel'],
  'JR’s SouthPork Ranch': ['Burrata Bomb', 'Caviar and Chicken Nuggets Package'],
  'Kama’aina Grill': [
    'Fried Saimin Noodles', 'Fried Saimin with Huli Chicken', 'Huli Chicken', 'Kalua Pork',
    'Kama’aina Bento', 'Kama’aina Mix', 'Kapu Poke Bowl', 'Massive Mix', 'Northshore Poke Bowl',
    'Shoyu Poke Bowl', 'Spam Musubi', 'Waimea Poke Bowl',
  ],
  'McGrath’s Funnel Cakes': ['Biscoff Cookie Butter Cheesecake Funnel Cake'],
  'The Nut Farm': ['Caramel Apple Cheesecake Roasted Pecans'],
  'Old West Roadhouse BBQ': ['BBQ Pulled Pork Cheddar Corn Bread Waffle'],
  'Pioneer Wagon': ['Scotch Egg'],
  'Po-Boys': ['Liberty Shrimp Melt'],
  'Pretzels': ['Garlic Parmesan Pretzel', 'Jalapeño White Cheddar Pretzel Dog'],
  'The Rib Shack': ['Ultimate Bacon-Brisket Mac & Cheese Donut'],
  'Saigonais Cuisine': ['Saigon Birria Pupusa'],
  'The Salad Bowl': ['Iowa Sweet Corn & Popcorn Sundae'],
  'Sampler Corndog Stand': ['PB & J Corndog'],
  'Sleepy Bison Grill': ['Bison Burger', 'Bison Cheesesteak Slider', 'Bison Nachos'],
  'Smith’s': ['Bedrock Twist'],
  'Smokey’s Grill': ['Hd-Smokin’ Cowboy Dog'],
  'The Snack Box': ['Cinnamon Cloud Rolls'],
  'Stockman’s Inn': ['Cowboy Candy', 'Porky Pileup'],
  'Taylor Concessions': ['Banana Cream Fries'],
  'The Veggie-Table': ['Fried Green Tomatoes'],
  'Waffle Chix': ['Loaded Sausage Waffle Stick'],
  'What’s Your Cheez': ['America’s “Berry” Good Grilled Cheese'],
  'Wiseguys Woodfired Pizza': ['Candied Pork Belly Mac & Cheese Pizza Slice'],
  'Wonder Bars': ['Walkin’ Oreo® Sundae'],
};

// ---------------------------------------------------------------------------
// Amenity legend.  Source: [MAP] legend.
//
// Only categories the app surfaces. Individual icon positions on the map artwork are not
// transcribed — there are ~40 restroom icons alone and reading each off the image would
// invent precision. Instead these are attached to the landmarks the map places them at, and
// the UI says "at <landmark>" rather than implying a surveyed point.
// ---------------------------------------------------------------------------

const AMENITIES = [
  { kind: 'first-aid', name: 'Hy-Vee Health & First Aid Center', landmark: 'First Aid Center', detail: 'Staffed by Des Moines Fire and Rescue' },
  { kind: 'first-aid', name: 'First aid — Service Center', landmark: 'Service Center', detail: 'First aid, ATMs, telephones, calming room' },
  { kind: 'info', name: 'Guest Relations Office', landmark: 'Administration Building', detail: 'Guest Relations; administration offices' },
  { kind: 'info', name: 'Guest Services — Thrill Town', landmark: 'Guest Services' },
  { kind: 'info', name: 'ISF Hub', landmark: 'ISF Hub', detail: 'Information volunteer HQ; credential pickup' },
  { kind: 'police', name: 'Iowa State Fair Police', landmark: 'Iowa State Fair Police', detail: 'Certified 24-hour police station; missing persons; lost and found' },
  { kind: 'atm', name: 'ATMs — Service Center', landmark: 'Service Center' },
  { kind: 'transit', name: 'Transit Hub', landmark: 'Transit Hub' },
  { kind: 'ride', name: 'Sky Glider East', landmark: 'Sky Glider East', detail: 'Ride above the eastern part of the fairgrounds' },
  { kind: 'ride', name: 'Sky Glider West', landmark: 'Sky Glider West', detail: 'Ride above the western part of the fairgrounds' },
  { kind: 'ride', name: 'Ye Old Mill', landmark: 'Ye Old Mill', detail: 'Oldest ride at the Fair — a 1,500 foot boat ride' },
  { kind: 'attraction', name: 'Butter Cow', landmark: 'Agriculture Building', detail: 'World-famous Butter Cow, in the John Deere Agriculture Building' },
  { kind: 'attraction', name: 'Big Boar', landmark: 'Big Boar', detail: 'In the Swine Barn' },
  { kind: 'attraction', name: 'Big Ram', landmark: 'Big Ram', detail: 'In the Sheep Barn' },
  { kind: 'attraction', name: 'Little Hands on the Farm', landmark: 'Little Hands on the Farm', detail: 'Hands-on farming exhibit for children' },
  { kind: 'attraction', name: 'Avenue of Breeds', landmark: 'Avenue of Breeds', detail: 'Unique breeds of Iowa livestock' },
  { kind: 'shade', name: 'Shivers Plaza', landmark: 'Shivers Plaza', detail: 'Shade and seating' },
  { kind: 'shade', name: 'The Lawn', landmark: 'The Lawn', detail: 'Outdoor performances with shade and tables' },
  { kind: 'shade', name: 'Legacy Terrace', landmark: 'Legacy Terrace', detail: 'Benches, water feature, flag display' },
];

module.exports = {
  FAIR, LANDMARK_GRID, ALIASES, WATER, RESTROOMS, RANKED, NEW_ITEMS, AMENITIES,
};
