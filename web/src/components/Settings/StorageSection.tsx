import { create } from "@bufbuild/protobuf";
import { isEqual } from "lodash-es";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useInstance } from "@/contexts/InstanceContext";
import { handleError } from "@/lib/error";
import {
  InstanceSetting_Key,
  InstanceSetting_StorageSetting,
  InstanceSetting_StorageSetting_S3Config,
  InstanceSetting_StorageSetting_S3ConfigSchema,
  InstanceSetting_StorageSetting_StorageType,
  InstanceSetting_StorageSettingSchema,
  InstanceSettingSchema,
} from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";

const R2_STORAGE_TYPE = 4 as InstanceSetting_StorageSetting_StorageType;
const STORAGE_OPTIONS: Array<{
  value: InstanceSetting_StorageSetting_StorageType;
  id: string;
  label: string | ((t: ReturnType<typeof useTranslate>) => string);
}> = [
  {
    value: InstanceSetting_StorageSetting_StorageType.DATABASE,
    id: "database",
    label: (t) => t("setting.storage.type-database"),
  },
  {
    value: InstanceSetting_StorageSetting_StorageType.LOCAL,
    id: "local",
    label: (t) => t("setting.storage.type-local"),
  },
  {
    value: InstanceSetting_StorageSetting_StorageType.S3,
    id: "s3",
    label: "S3",
  },
  {
    value: R2_STORAGE_TYPE,
    id: "r2",
    label: "R2",
  },
];

const createS3Config = (
  current: InstanceSetting_StorageSetting_S3Config | undefined,
  patch: Partial<InstanceSetting_StorageSetting_S3Config>,
) =>
  create(InstanceSetting_StorageSetting_S3ConfigSchema, {
    accessKeyId: current?.accessKeyId ?? "",
    accessKeySecret: current?.accessKeySecret ?? "",
    endpoint: current?.endpoint ?? "",
    region: current?.region ?? "",
    bucket: current?.bucket ?? "",
    usePathStyle: current?.usePathStyle ?? false,
    ...patch,
  });

const StorageSection = () => {
  const t = useTranslate();
  const { storageSetting: originalSetting, storageSupportedTypes, updateSetting, fetchSetting } = useInstance();
  const [localSetting, setLocalSetting] = useState<InstanceSetting_StorageSetting>(originalSetting);

  useEffect(() => {
    setLocalSetting(originalSetting);
  }, [originalSetting]);

  useEffect(() => {
    fetchSetting(InstanceSetting_Key.STORAGE).catch(() => {
      // Keep fallback value if fetch is not available for current user.
    });
  }, [fetchSetting]);

  useEffect(() => {
    if (storageSupportedTypes.length === 0) return;
    if (storageSupportedTypes.includes(localSetting.storageType)) return;
    setLocalSetting(
      create(InstanceSetting_StorageSettingSchema, {
        ...localSetting,
        storageType: storageSupportedTypes[0],
      }),
    );
  }, [localSetting, storageSupportedTypes]);

  const updatePartial = (partial: Partial<InstanceSetting_StorageSetting>) => {
    setLocalSetting(
      create(InstanceSetting_StorageSettingSchema, {
        ...localSetting,
        ...partial,
      }),
    );
  };

  const handleSave = async () => {
    try {
      await updateSetting(
        create(InstanceSettingSchema, {
          name: `instance/settings/${InstanceSetting_Key[InstanceSetting_Key.STORAGE]}`,
          value: {
            case: "storageSetting",
            value: localSetting,
          },
        }),
      );
      await fetchSetting(InstanceSetting_Key.STORAGE);
      toast.success(t("message.update-succeed"));
    } catch (error: unknown) {
      await handleError(error, toast.error, {
        context: "Update storage settings",
      });
    }
  };

  const hasChanges = !isEqual(localSetting, originalSetting);
  const orderedStorageOptions = storageSupportedTypes
    .map((supportedType) => STORAGE_OPTIONS.find((option) => option.value === supportedType))
    .filter((option): option is (typeof STORAGE_OPTIONS)[number] => Boolean(option));

  return (
    <SettingSection title={t("setting.storage.label")}>
      <SettingGroup title={t("setting.storage.current-storage")}>
        <div className="w-full">
          <RadioGroup
            value={String(localSetting.storageType)}
            className="flex flex-row gap-4"
            onValueChange={(v) =>
              updatePartial({
                storageType: Number(v) as InstanceSetting_StorageSetting_StorageType,
              })
            }
          >
            {orderedStorageOptions.map((option) => (
              <div key={option.id} className="flex items-center space-x-2">
                <RadioGroupItem value={String(option.value)} id={option.id} />
                <Label htmlFor={option.id}>{typeof option.label === "function" ? option.label(t) : option.label}</Label>
              </div>
            ))}
          </RadioGroup>
        </div>

        <SettingRow label={t("setting.system.max-upload-size")} tooltip={t("setting.system.max-upload-size-hint")}>
          <Input
            className="w-24 font-mono"
            value={String(localSetting.uploadSizeLimitMb ?? 0n)}
            onChange={(e) =>
              updatePartial({
                uploadSizeLimitMb: BigInt(Number(e.target.value) || 0),
              })
            }
          />
        </SettingRow>

        {localSetting.storageType !== InstanceSetting_StorageSetting_StorageType.DATABASE && (
          <SettingRow label={t("setting.storage.filepath-template")}>
            <Input
              className="w-64"
              value={localSetting.filepathTemplate}
              onChange={(e) => updatePartial({ filepathTemplate: e.target.value })}
              placeholder="assets/{timestamp}_{filename}"
            />
          </SettingRow>
        )}
      </SettingGroup>

      {localSetting.storageType === InstanceSetting_StorageSetting_StorageType.S3 && (
        <SettingGroup title="S3 Configuration" showSeparator>
          <SettingRow label={t("setting.storage.accesskey")}>
            <Input
              className="w-64"
              value={localSetting.s3Config?.accessKeyId ?? ""}
              onChange={(e) =>
                updatePartial({
                  s3Config: createS3Config(localSetting.s3Config, { accessKeyId: e.target.value }),
                })
              }
            />
          </SettingRow>

          <SettingRow label={t("setting.storage.secretkey")}>
            <Input
              className="w-64"
              type="password"
              value={localSetting.s3Config?.accessKeySecret ?? ""}
              onChange={(e) =>
                updatePartial({
                  s3Config: createS3Config(localSetting.s3Config, { accessKeySecret: e.target.value }),
                })
              }
            />
          </SettingRow>

          <SettingRow label={t("setting.storage.endpoint")}>
            <Input
              className="w-64"
              value={localSetting.s3Config?.endpoint ?? ""}
              onChange={(e) =>
                updatePartial({
                  s3Config: createS3Config(localSetting.s3Config, { endpoint: e.target.value }),
                })
              }
            />
          </SettingRow>

          <SettingRow label={t("setting.storage.region")}>
            <Input
              className="w-64"
              value={localSetting.s3Config?.region ?? ""}
              onChange={(e) =>
                updatePartial({
                  s3Config: createS3Config(localSetting.s3Config, { region: e.target.value }),
                })
              }
            />
          </SettingRow>

          <SettingRow label={t("setting.storage.bucket")}>
            <Input
              className="w-64"
              value={localSetting.s3Config?.bucket ?? ""}
              onChange={(e) =>
                updatePartial({
                  s3Config: createS3Config(localSetting.s3Config, { bucket: e.target.value }),
                })
              }
            />
          </SettingRow>

          <SettingRow label="Use Path Style">
            <Switch
              checked={localSetting.s3Config?.usePathStyle ?? false}
              onCheckedChange={(checked) =>
                updatePartial({
                  s3Config: createS3Config(localSetting.s3Config, { usePathStyle: checked }),
                })
              }
            />
          </SettingRow>
        </SettingGroup>
      )}
      <div className="w-full flex justify-end">
        <Button disabled={!hasChanges} onClick={handleSave}>
          {t("common.save")}
        </Button>
      </div>
    </SettingSection>
  );
};

export default StorageSection;
