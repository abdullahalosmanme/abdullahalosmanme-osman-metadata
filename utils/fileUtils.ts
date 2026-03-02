
import { ImageData } from "../types";

export const fileToBase64 = (file: File): Promise<{ base64: string; mimeType: string }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve({ base64, mimeType: file.type });
    };
    reader.onerror = (error) => reject(error);
  });
};

export const downloadCSV = (data: ImageData[]) => {
  const headers = ["Filename", "Title", "Keywords"];
  const rows = data
    .filter(img => img.status === 'completed' && img.metadata)
    .map(img => [
      img.file.name,
      `"${img.metadata?.title.replace(/"/g, '""')}"`,
      `"${img.metadata?.keywords.replace(/"/g, '""')}"`
    ]);

  const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `OSMAN_Metadata_${new Date().getTime()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
