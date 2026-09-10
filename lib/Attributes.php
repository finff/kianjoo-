<?php
/**
 * SenseTime / SenseFoundry "Attribute Feature Definition" dictionary.
 * Source: SenseStudio V2.13.0 API Documentation, section 5.2.4.
 *
 * Each attribute in an HTTP-Push event is {key, value, conf}, where `key` is the
 * numeric Feature ID below and `value` is the numeric Feature Value. This class
 * turns those numbers into human-readable names so downstream use cases
 * (PPE / smoking / crowd / demographics / vehicle...) can be built without
 * re-learning the codes.
 *
 * Feature IDs do not collide across categories, so a single flat map is used.
 * Entries with 'raw' => true carry a free numeric/string value (age, temp,
 * plate, brand, count) rather than an enumerated one.
 */

declare(strict_types=1);

final class Attributes
{
    /** @var array<int,array{name:string,category:string,raw?:bool,values?:array<int|string,string>}> */
    private const MAP = [
        // ── Person Group ─────────────────────────────────────
        0  => ['name' => 'PersonGroup', 'category' => 'personGroup', 'values' => [-99 => 'Strangers']],

        // ── Intelligent Device ───────────────────────────────
        75 => ['name' => 'AbnormalType', 'category' => 'device', 'values' => [
            0 => 'None', 1 => 'FaceIDMismatch', 2 => 'FaceCardMismatch', 3 => 'FaceCodeMismatch',
            4 => 'InvalidVisitingPeriod', 5 => 'InvalidAccessibleTime', 6 => 'InvalidIDCard',
            7 => 'InvalidICCard', 8 => 'InvalidQRCode', 9 => 'AbnormalBodyTemperature',
        ]],

        // ── Pedestrian ───────────────────────────────────────
        -1 => ['name' => 'All(Human)', 'category' => 'pedestrian', 'values' => [0 => 'No', 1 => 'Yes']],
        4  => ['name' => 'Age', 'category' => 'pedestrian', 'values' => [0 => 'Adult', 1 => 'Old', 2 => 'Child']],
        5  => ['name' => 'Gender', 'category' => 'pedestrian', 'values' => [0 => 'Male', 1 => 'Female', 2 => 'Unknown', 99 => 'Unknown']],
        6  => ['name' => 'Angle', 'category' => 'pedestrian', 'values' => [0 => 'Front', 1 => 'Side', 2 => 'Back']],
        7  => ['name' => 'WithUmbrella', 'category' => 'pedestrian', 'values' => [0 => 'NoUmbrella', 1 => 'WithUmbrella']],
        8  => ['name' => 'BagType', 'category' => 'pedestrian', 'values' => [
            0 => 'HandBag', 1 => 'ShoulderBag', 2 => 'Backpack', 3 => 'Trolley', 4 => 'NoBag', 8 => 'WaistPack',
        ]],
        9  => ['name' => 'SleevesType', 'category' => 'pedestrian', 'values' => [0 => 'ShortSleeve', 1 => 'LongSleeve', 2 => 'Shirtless']],
        10 => ['name' => 'BottomsType', 'category' => 'pedestrian', 'values' => [0 => 'Trousers', 1 => 'Shorts', 2 => 'Skirt']],
        11 => ['name' => 'TopsColor', 'category' => 'pedestrian', 'values' => self::COLORS_0],
        12 => ['name' => 'BottomsColor', 'category' => 'pedestrian', 'values' => self::COLORS_0],
        13 => ['name' => 'TopsPattern', 'category' => 'pedestrian', 'values' => [0 => 'Solid', 1 => 'Stripes', 2 => 'Graphic', 3 => 'Joint', 4 => 'Checks']],
        14 => ['name' => 'UmbrellaColor', 'category' => 'pedestrian', 'values' => self::COLORS_1],
        15 => ['name' => 'ShoesType', 'category' => 'pedestrian', 'values' => [2 => 'LeatherShoes', 5 => 'Sandals', 6 => 'CasualShoes', 7 => 'Boots']],
        16 => ['name' => 'HatsType', 'category' => 'pedestrian', 'values' => [0 => 'NoHat', 5 => 'BucketHat', 6 => 'Bonnet', 7 => 'Cap', 9 => 'Helmet']],
        17 => ['name' => 'BottomsPattern', 'category' => 'pedestrian', 'values' => [0 => 'Solid', 1 => 'Stripes', 2 => 'Graphic', 3 => 'Joint', 4 => 'Checks']],
        18 => ['name' => 'HoldingThings', 'category' => 'pedestrian', 'values' => [0 => 'HoldObject']],
        22 => ['name' => 'TopsType', 'category' => 'pedestrian', 'values' => [
            1 => 'BusinessSuit', 3 => 'T-Shirt', 4 => 'Shirt', 6 => 'Jacket', 8 => 'LongCoat',
            10 => 'Sweater', 12 => 'DownCoat', 13 => 'SportsWear', 17 => 'Dress', 99 => 'Others',
        ]],
        23 => ['name' => 'HairStyle', 'category' => 'pedestrian', 'values' => [6 => 'Bald', 11 => 'Long', 100 => 'Short']],
        24 => ['name' => 'HairColor', 'category' => 'pedestrian', 'values' => self::COLORS_1],
        25 => ['name' => 'ShoesColor', 'category' => 'pedestrian', 'values' => self::COLORS_1],
        26 => ['name' => 'BagColor', 'category' => 'pedestrian', 'values' => self::COLORS_1],
        27 => ['name' => 'WithMask', 'category' => 'pedestrian', 'values' => [0 => 'Unknown', 1 => 'Unrecognized', 2 => 'NoMask', 3 => 'WithMask', 4 => 'WithAbnormalMask']],
        28 => ['name' => 'MaskColor', 'category' => 'pedestrian', 'values' => self::COLORS_1],
        29 => ['name' => 'HatsColor', 'category' => 'pedestrian', 'values' => self::COLORS_1],
        55 => ['name' => 'SkinColor', 'category' => 'pedestrian', 'values' => [2 => 'Yellow', 3 => 'Black', 4 => 'White']],
        56 => ['name' => 'ExpressionType', 'category' => 'pedestrian', 'values' => [
            1 => 'Glasses', 2 => 'OrdinaryGlasses', 3 => 'Anger', 4 => 'Sad', 5 => 'Disgust', 6 => 'Fear',
            7 => 'Surprise', 8 => 'Normal', 9 => 'Calm', 10 => 'NoGlasses', 11 => 'Joy', 12 => 'Confusion',
            13 => 'Scream', 14 => 'SunGlasses', 15 => 'Depression', 16 => 'Yawn',
        ]],
        57 => ['name' => 'AgeEstimation', 'category' => 'pedestrian', 'raw' => true],
        58 => ['name' => 'UniformType', 'category' => 'pedestrian', 'values' => [
            0 => 'GeneralUniform', 1 => 'OfficeUniform', 2 => 'WorkerUniform', 3 => 'ChefClothes',
            4 => 'MedicalClothes', 5 => 'PoliceUniform', 6 => 'FireFightingCoat', 8 => 'ElemeUniform', 10 => 'MeituanUniform',
        ]],
        59 => ['name' => 'PedestrianBehavior', 'category' => 'pedestrian', 'values' => [
            0 => 'Normal', 1 => 'HoldingThings', 2 => 'PlayingWithSmartPhone', 3 => 'MakingPhoneCall', 5 => 'UnDetected',
        ]],
        60 => ['name' => 'WithGlove', 'category' => 'pedestrian', 'values' => [0 => 'WithGlove', 1 => 'NoGlove']],
        61 => ['name' => 'Pose', 'category' => 'pedestrian', 'values' => [0 => 'Stand', 1 => 'Sit', 2 => 'LieDown', 3 => 'SleepOnTable']],
        62 => ['name' => 'WithReflectiveVest', 'category' => 'pedestrian', 'values' => [0 => 'ReflectiveVest', 1 => 'NoReflectiveVest']],
        63 => ['name' => 'Smoking', 'category' => 'pedestrian', 'values' => [0 => 'IsSmoking', 1 => 'NoSmoking', 2 => 'Unknown']],
        70 => ['name' => 'WithBag', 'category' => 'pedestrian', 'values' => [0 => 'WithBag']],
        71 => ['name' => 'WithHat', 'category' => 'pedestrian', 'values' => [0 => 'WithHat']],
        72 => ['name' => 'AgeUpperLimit', 'category' => 'pedestrian', 'values' => [0 => '90', 1 => '59', 2 => '14']],
        73 => ['name' => 'AgeLowerLimit', 'category' => 'pedestrian', 'values' => [0 => '60', 1 => '18', 2 => '0']],
        74 => ['name' => 'BodyTemperature', 'category' => 'pedestrian', 'raw' => true],
        76 => ['name' => 'WithBeard', 'category' => 'pedestrian', 'values' => [0 => 'Unknown', 1 => 'Unrecognized', 2 => 'NoMoustache', 3 => 'Moustache']],

        // ── Vehicle ──────────────────────────────────────────
        -3 => ['name' => 'All(Vehicle)', 'category' => 'vehicle', 'values' => [0 => 'No', 1 => 'Yes']],
        1  => ['name' => 'VehicleColor', 'category' => 'vehicle', 'values' => [
            0 => 'Gray', 1 => 'White', 2 => 'Red', 3 => 'Black', 4 => 'Blue', 5 => 'Green', 6 => 'Brown', 7 => 'Yellow', 8 => 'Purple', 9 => 'Pink',
        ]],
        2  => ['name' => 'VehicleType', 'category' => 'vehicle', 'values' => [
            0 => 'Car', 1 => 'Van', 2 => 'SmallTruck', 3 => 'BigTruck', 4 => 'SUV', 5 => 'LargeBus',
            6 => 'MediumBus', 7 => 'BigCoach', 8 => 'AutomobileTypeOther',
        ]],
        3  => ['name' => 'CarSubBrand', 'category' => 'vehicle', 'raw' => true],
        79 => ['name' => 'CarBrand', 'category' => 'vehicle', 'raw' => true],
        80 => ['name' => 'CarPlate', 'category' => 'vehicle', 'raw' => true],
        81 => ['name' => 'VehicleCategory', 'category' => 'vehicle', 'values' => [
            0 => 'GeneralVehicle', 1 => 'Ambulance', 2 => 'FireTruck', 3 => 'GuardCar', 4 => 'DumpTruck', 5 => 'MixerTruck', 6 => 'Taxi',
        ]],
        82 => ['name' => 'CarPlateColor', 'category' => 'vehicle', 'values' => [
            0 => 'None', 1 => 'Black', 2 => 'Blue', 3 => 'Green', 4 => 'Yellow', 5 => 'YellowGreen', 6 => 'White',
        ]],
        83 => ['name' => 'CarPlateType', 'category' => 'vehicle', 'values' => [
            0 => 'None', 1 => 'LargeVehicle', 2 => 'Trailer', 3 => 'LargeNewEnergyVehicle', 4 => 'SmallVehicle',
            5 => 'SmallNewEnergyVehicle', 6 => 'EmbassyVehicle', 7 => 'ConsularVehicle', 8 => 'HK/MacaoVehicle',
            9 => 'TrainingVehicle', 10 => 'PolicyVehicle', 11 => 'FireRescueVehicle', 12 => 'ArmedPoliceVehicle',
            13 => 'ArmyVehicle', 14 => 'HK/MacaoLocalVehicle',
        ]],

        // ── Non-motor Vehicle ────────────────────────────────
        -2 => ['name' => 'All(Moped)', 'category' => 'moped', 'values' => [0 => 'No', 1 => 'Yes']],
        77 => ['name' => 'MopedColor', 'category' => 'moped', 'values' => [
            0 => 'Gray', 1 => 'White', 2 => 'Red', 3 => 'Black', 4 => 'Blue', 5 => 'Green', 6 => 'Brown', 7 => 'Yellow', 8 => 'Purple', 9 => 'Pink',
        ]],
        78 => ['name' => 'MopedType', 'category' => 'moped', 'values' => [
            0 => 'e-bike', 1 => 'motor', 2 => 'bicycle', 3 => 'tricycle', 4 => 'pram', 5 => 'wheelchair', 6 => 'other moped',
        ]],

        // ── Crowd ────────────────────────────────────────────
        21 => ['name' => 'CrowdAlarm', 'category' => 'crowd', 'values' => [3 => 'Lingering']],
        54 => ['name' => 'PeopleCount', 'category' => 'crowd', 'raw' => true],
    ];

    // Shared colour palettes. COLORS_0 is 0-indexed (TopsColor/BottomsColor);
    // COLORS_1 is 1-indexed (HairColor/ShoesColor/BagColor/Mask/Hats/Umbrella).
    private const COLORS_0 = [
        0 => 'Black', 1 => 'White', 2 => 'Gray', 3 => 'Red', 4 => 'Yellow', 5 => 'Blue',
        6 => 'Green', 7 => 'Purple', 8 => 'Orange', 9 => 'Brown', 10 => 'Cyan', 11 => 'Pink', 13 => 'Transparent',
    ];
    private const COLORS_1 = [
        1 => 'Black', 2 => 'White', 3 => 'Gray', 4 => 'Red', 5 => 'Blue', 6 => 'Yellow',
        7 => 'Orange', 8 => 'Brown', 9 => 'Green', 10 => 'Purple', 11 => 'Cyan', 12 => 'Pink', 13 => 'Transparent',
    ];

    /**
     * Live overrides harvested from SenseStudio itself (policy targets carry
     * targetEnName / targetEnOption for every feature an operator configured).
     * Shape: [featureId => ['name' => …, 'values' => [value => name]]].
     *
     * @var array<string,array{name?:string,values?:array<string,string>}>
     */
    private static array $live = [];

    /** Install the SenseStudio-sourced dictionary; names from it win over §5.2.4. */
    public static function useLiveDictionary(array $features): void
    {
        self::$live = $features;
    }

    /** The dictionary currently in effect, static table merged with live names. */
    public static function dictionary(): array
    {
        $out = [];
        foreach (self::MAP as $id => $def) {
            $out[(string) $id] = [
                'name'     => $def['name'],
                'category' => $def['category'],
                'raw'      => !empty($def['raw']),
                'values'   => array_map('strval', $def['values'] ?? []),
                'source'   => 'doc',
            ];
        }
        foreach (self::$live as $id => $def) {
            $id = (string) $id;
            $out[$id]['name']     = $def['name'] ?? ($out[$id]['name'] ?? $id);
            $out[$id]['category'] = $out[$id]['category'] ?? 'pedestrian';
            $out[$id]['raw']      = $out[$id]['raw'] ?? false;
            $out[$id]['values']   = ($out[$id]['values'] ?? []) + array_map('strval', $def['values'] ?? []);
            $out[$id]['source']   = 'sensestudio';
        }
        ksort($out, SORT_NATURAL);
        return $out;
    }

    /**
     * Decode one attribute {key,value,conf} into a readable record.
     *
     * @return array{key:string,feature:?string,category:?string,value:string,value_name:?string,conf:?float}
     */
    public static function decodeOne(string $key, string $value, ?string $conf = null): array
    {
        $id  = self::isIntLike($key) ? (int) $key : null;
        $def = ($id !== null && isset(self::MAP[$id])) ? self::MAP[$id] : null;

        $feature   = $def['name'] ?? null;
        $category  = $def['category'] ?? null;
        $valueName = null;

        // SenseStudio's own naming for this feature/value, when we have it.
        $liveDef = self::$live[$key] ?? self::$live[(string) $id] ?? null;
        if (is_array($liveDef)) {
            if (!empty($liveDef['name'])) {
                $feature = (string) $liveDef['name'];
                $category = $category ?? 'pedestrian';
            }
            if (isset($liveDef['values'][$value]) && $liveDef['values'][$value] !== '') {
                $valueName = (string) $liveDef['values'][$value];
            }
        }
        if ($valueName !== null) {
            return [
                'key'        => $key,
                'feature'    => $feature,
                'category'   => $category,
                'value'      => $value,
                'value_name' => $valueName,
                'conf'       => ($conf !== null && $conf !== '') ? round((float) $conf, 5) : null,
            ];
        }

        if ($def !== null) {
            if (!empty($def['raw'])) {
                $valueName = $value; // free numeric/string value
            } elseif (isset($def['values'])) {
                $vid = self::isIntLike($value) ? (int) $value : $value;
                $valueName = $def['values'][$vid] ?? null;
            }
        }

        return [
            'key'        => $key,
            'feature'    => $feature,
            'category'   => $category,
            'value'      => $value,
            'value_name' => $valueName,
            'conf'       => ($conf !== null && $conf !== '') ? round((float) $conf, 5) : null,
        ];
    }

    /**
     * Decode a full attributes array from a payload.
     *
     * @param array<int,array<string,mixed>> $attributes
     * @return array{list:array<int,array>,map:array<string,string>}
     *   - list: detailed per-attribute records
     *   - map:  compact { FeatureName: ValueName } for quick consumption
     */
    public static function decodeAll(array $attributes): array
    {
        $list = [];
        $map  = [];
        foreach ($attributes as $a) {
            if (!is_array($a) || !isset($a['key'])) {
                continue;
            }
            $rec = self::decodeOne(
                (string) $a['key'],
                isset($a['value']) ? (string) $a['value'] : '',
                isset($a['conf']) ? (string) $a['conf'] : null
            );
            $list[] = $rec;
            if ($rec['feature'] !== null) {
                $map[$rec['feature']] = $rec['value_name'] ?? $rec['value'];
            }
        }
        return ['list' => $list, 'map' => $map];
    }

    private static function isIntLike(string $s): bool
    {
        return $s !== '' && preg_match('/^-?\d+$/', $s) === 1;
    }
}
