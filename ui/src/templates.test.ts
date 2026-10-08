import { expect, test } from "vitest";
import { defaultTemplateConfig, newNotePath, templateDefault, templateRequest } from "./templates";
test("folder defaults inherit by directory boundary and Blank stops inheritance", () => {
  const c={...defaultTemplateConfig(),rules:[{folder:"",template:"Templates/Project.md"},{folder:"Meetings",template:"Templates/Meeting.md"},{folder:"Meetings/Retros",template:"Templates/Retro.md"},{folder:"Meetings/Private",template:null}]};
  expect(templateDefault(c,"Meetings/Retros/2026/Review.md")).toEqual({template:"Templates/Retro.md",rule_folder:"Meetings/Retros"});
  expect(templateDefault(c,"MeetingsExtra/Review.md").template).toBe("Templates/Project.md");
  expect(templateDefault(c,"Meetings/Private/Review.md").template).toBeNull();
  expect(templateDefault(c,"Templates/New.md").template).toBeNull();
});
test("final filenames and selections distinguish default, explicit and blank", () => {
  expect(newNotePath("Meetings/Retros"," Sprint 5.md ")).toBe("Meetings/Retros/Sprint 5.md");
  expect(newNotePath("","Brainstorm.MD")).toBe("Brainstorm.md");
  for(const n of ["", ".md", "../Escape", "Bad/Name", ".hidden", "Bad\\Name"]) expect(()=>newNotePath("",n)).toThrow();
  expect(templateRequest("A.md","default","time")).toMatchObject({template:null,blank:false});
  expect(templateRequest("A.md","blank","time")).toMatchObject({template:null,blank:true});
  expect(templateRequest("A.md","Templates/Analysis.md","time")).toMatchObject({template:"Templates/Analysis.md",blank:false});
});
